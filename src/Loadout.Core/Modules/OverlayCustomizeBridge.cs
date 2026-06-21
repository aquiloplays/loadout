using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Loadout.Bus;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;
using Newtonsoft.Json.Linq;

namespace Loadout.Modules
{
    /// <summary>
    /// Bus bridge between the aquilo.gg overlay customizer page and the
    /// local DLL. Two message kinds:
    ///
    ///   loadout.overlay.snapshot.request
    ///     in:  { overlay: "counters" }            (overlay optional - omit for all)
    ///     out: { overlay: "counters", config: {...} }
    ///        Returned via the in-process handler reply so the requester
    ///        gets it directly. Used on customize-page load to populate
    ///        every control with the current value.
    ///
    ///   loadout.overlay.update
    ///     in:  { overlay: "counters", path: "Opacity", value: 80 }
    ///     out: { overlay: "counters", path: "Opacity", value: 80, ok: true }
    ///        Mutates the named setting field on the relevant config
    ///        object, persists settings.json (debounced), then republishes
    ///        as loadout.overlay.config so any subscribing overlay can
    ///        live-update without an OBS source refresh.
    ///
    /// "path" supports nested dotted access ("Counters[0].Color" works
    /// for list-indexed fields). Type coercion handles JSON-friendly
    /// values: ints, doubles, bools, strings; missing/invalid paths fail
    /// with ok=false and a "reason" describing the problem.
    ///
    /// Whitelist: only settings reachable through this map can be
    /// mutated. Prevents the bus protocol from being abused to flip
    /// arbitrary internal state (e.g. SyncSecret, OnboardingDone).
    /// </summary>
    public static class OverlayCustomizeBridge
    {
        // Per-overlay handle → resolver that returns the live config object.
        // Adding a new overlay to the customizer = add a row here.
        private static readonly Dictionary<string, Func<LoadoutSettings, object>> _overlayResolvers =
            new Dictionary<string, Func<LoadoutSettings, object>>(StringComparer.OrdinalIgnoreCase)
        {
            { "counters",  s => s.Counters    },
            { "checkin",   s => s.CheckIn     },
            { "check-in",  s => s.CheckIn     },
            { "goals",     s => s.Goals       },
            { "bolts",     s => s.Bolts       },
            { "hype",      s => s.HypeTrain   },
            { "hypetrain", s => s.HypeTrain   },
            { "alerts",    s => s.Alerts      },
            { "welcomes",  s => s.Welcomes    },
            { "theme",     s => s.OverlayTheme },
            // Not an overlay per se, but the customizer page can edit
            // the top-level Game Interactions knobs (master toggle,
            // foreground window, cooldown multiplier, rate cap) over
            // the same bus protocol. Action-list editing stays in the
            // Settings window because dotted-path-by-index is too
            // clunky for a 14-column DataGrid.
            { "gameinteractions", s => s.GameInteractions }
        };

        public static void Register()
        {
            AquiloBus.Instance.RegisterHandler("loadout.overlay.snapshot.request", OnSnapshotRequest);
            AquiloBus.Instance.RegisterHandler("loadout.overlay.update",           OnUpdate);
        }

        private static BusMessage OnSnapshotRequest(string fromClient, BusMessage incoming)
        {
            try
            {
                var s = SettingsManager.Instance.Current;
                var requested = incoming?.Data is JObject d ? d.Value<string>("overlay") : null;
                if (!string.IsNullOrWhiteSpace(requested))
                {
                    if (!_overlayResolvers.TryGetValue(requested, out var resolver))
                        return Reply("loadout.overlay.snapshot", new { overlay = requested, error = "unknown overlay" });
                    return Reply("loadout.overlay.snapshot", new
                    {
                        overlay = requested,
                        config  = resolver(s)
                    });
                }
                // Full snapshot — every supported overlay.
                var bundle = new Dictionary<string, object>();
                foreach (var kv in _overlayResolvers) bundle[kv.Key] = kv.Value(s);
                return Reply("loadout.overlay.snapshot", new { overlays = bundle });
            }
            catch (Exception ex)
            {
                ErrorLog.Write("OverlayCustomizeBridge.Snapshot", ex);
                return Reply("loadout.overlay.snapshot", new { error = ex.Message });
            }
        }

        private static BusMessage OnUpdate(string fromClient, BusMessage incoming)
        {
            string overlay = null, path = null;
            JToken value = null;
            try
            {
                if (incoming?.Data is JObject d)
                {
                    overlay = d.Value<string>("overlay");
                    path    = d.Value<string>("path");
                    value   = d["value"];
                }
                if (string.IsNullOrWhiteSpace(overlay) || string.IsNullOrWhiteSpace(path))
                    return Reply("loadout.overlay.update.ack", new { ok = false, reason = "overlay+path required" });
                if (!_overlayResolvers.TryGetValue(overlay, out var resolver))
                    return Reply("loadout.overlay.update.ack", new { ok = false, reason = "unknown overlay", overlay });

                string applied = null;
                SettingsManager.Instance.Mutate(s =>
                {
                    var root = resolver(s);
                    applied = ApplyPath(root, path, value);
                });

                if (applied != null)
                    return Reply("loadout.overlay.update.ack", new
                    {
                        ok = false, overlay, path, reason = applied
                    });

                // Republish snapshot so any overlay subscribing to live
                // config can react. Use Publish (fans out to subscribers)
                // instead of the in-process handler reply.
                var fresh = resolver(SettingsManager.Instance.Current);
                AquiloBus.Instance.Publish("loadout.overlay.config", new
                {
                    overlay,
                    path,
                    value = value?.ToObject<object>(),
                    config = fresh
                });

                return Reply("loadout.overlay.update.ack", new
                {
                    ok = true, overlay, path, value = value?.ToObject<object>()
                });
            }
            catch (Exception ex)
            {
                ErrorLog.Write("OverlayCustomizeBridge.Update", ex);
                return Reply("loadout.overlay.update.ack", new { ok = false, reason = ex.Message, overlay, path });
            }
        }

        /// <summary>
        /// Walk the dotted path against <paramref name="root"/> and write
        /// <paramref name="value"/> at the final segment. Returns null on
        /// success, or a human-readable reason string on failure.
        ///
        /// Supported segment forms:
        ///   PropertyName        — set a public instance property
        ///   List[3]             — index into a List&lt;T&gt;
        ///   Dict["key"]         — index into a Dictionary&lt;string,T&gt;
        ///
        /// Type coercion: JSON ints/doubles/bools/strings are converted
        /// to the target property's type via Convert.ChangeType; enums
        /// take strings.
        /// </summary>
        private static string ApplyPath(object root, string path, JToken value)
        {
            if (root == null) return "root config not loaded";
            var segments = SplitPath(path);
            if (segments.Count == 0) return "empty path";

            object cursor = root;
            for (int i = 0; i < segments.Count - 1; i++)
            {
                cursor = Step(cursor, segments[i], out var err);
                if (err != null) return err;
                if (cursor == null) return "null at segment '" + segments[i] + "'";
            }

            return Assign(cursor, segments[segments.Count - 1], value);
        }

        private static List<string> SplitPath(string path)
        {
            var result = new List<string>();
            if (string.IsNullOrEmpty(path)) return result;
            int start = 0;
            for (int i = 0; i < path.Length; i++)
            {
                var ch = path[i];
                if (ch == '.')
                {
                    if (i > start) result.Add(path.Substring(start, i - start));
                    start = i + 1;
                }
                else if (ch == '[')
                {
                    if (i > start) result.Add(path.Substring(start, i - start));
                    int close = path.IndexOf(']', i + 1);
                    if (close < 0) { result.Add(path.Substring(i)); return result; }
                    result.Add(path.Substring(i, close - i + 1));   // "[3]" or "[\"key\"]"
                    i = close;
                    start = i + 1;
                }
            }
            if (start < path.Length) result.Add(path.Substring(start));
            return result;
        }

        private static object Step(object obj, string seg, out string err)
        {
            err = null;
            if (seg.StartsWith("[") && seg.EndsWith("]"))
            {
                var inner = seg.Substring(1, seg.Length - 2).Trim();
                if (int.TryParse(inner, out var idx))
                {
                    var list = obj as System.Collections.IList;
                    if (list == null) { err = "expected list at " + seg; return null; }
                    if (idx < 0 || idx >= list.Count) { err = "index out of range " + seg; return null; }
                    return list[idx];
                }
                // Dict["key"] form.
                var key = inner.Trim('"', '\'');
                var dict = obj as System.Collections.IDictionary;
                if (dict == null) { err = "expected dict at " + seg; return null; }
                return dict.Contains(key) ? dict[key] : null;
            }
            var prop = obj.GetType().GetProperty(seg, BindingFlags.Public | BindingFlags.Instance);
            if (prop == null) { err = "no property '" + seg + "' on " + obj.GetType().Name; return null; }
            return prop.GetValue(obj);
        }

        private static string Assign(object container, string seg, JToken value)
        {
            try
            {
                if (seg.StartsWith("[") && seg.EndsWith("]"))
                {
                    var inner = seg.Substring(1, seg.Length - 2).Trim();
                    if (int.TryParse(inner, out var idx))
                    {
                        var list = container as System.Collections.IList;
                        if (list == null) return "expected list for " + seg;
                        if (idx < 0 || idx >= list.Count) return "index out of range " + seg;
                        // Element type comes from the list's runtime generic arg.
                        var elemType = container.GetType().IsGenericType
                            ? container.GetType().GetGenericArguments()[0]
                            : list[idx]?.GetType() ?? typeof(object);
                        list[idx] = CoerceTo(value, elemType);
                        return null;
                    }
                    var key = inner.Trim('"', '\'');
                    var dict = container as System.Collections.IDictionary;
                    if (dict == null) return "expected dict for " + seg;
                    var valType = container.GetType().IsGenericType
                        ? container.GetType().GetGenericArguments()[1]
                        : typeof(object);
                    dict[key] = CoerceTo(value, valType);
                    return null;
                }
                var prop = container.GetType().GetProperty(seg, BindingFlags.Public | BindingFlags.Instance);
                if (prop == null) return "no property '" + seg + "' on " + container.GetType().Name;
                if (!prop.CanWrite) return "property '" + seg + "' is read-only";
                prop.SetValue(container, CoerceTo(value, prop.PropertyType));
                return null;
            }
            catch (Exception ex)
            {
                return "assign failed: " + ex.Message;
            }
        }

        private static object CoerceTo(JToken value, Type target)
        {
            if (value == null || value.Type == JTokenType.Null) return null;
            var underlying = Nullable.GetUnderlyingType(target) ?? target;

            if (underlying.IsEnum)
            {
                var s = value.ToString();
                return Enum.Parse(underlying, s, ignoreCase: true);
            }
            if (underlying == typeof(string)) return value.ToString();
            if (underlying == typeof(bool))   return value.Value<bool>();
            if (underlying == typeof(int))    return value.Value<int>();
            if (underlying == typeof(long))   return value.Value<long>();
            if (underlying == typeof(double)) return value.Value<double>();
            if (underlying == typeof(float))  return (float)value.Value<double>();

            // Fallback: try Newtonsoft's deserialization for nested objects.
            return value.ToObject(target);
        }

        private static BusMessage Reply(string kind, object data)
        {
            return new BusMessage
            {
                V    = 1,
                Kind = kind,
                Data = data == null ? null : JToken.FromObject(data)
            };
        }
    }
}
