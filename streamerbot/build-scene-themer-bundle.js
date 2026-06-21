#!/usr/bin/env node
// streamerbot/build-scene-themer-bundle.js
//
// Generates streamerbot/scene-themer-import.bundle.json from the C# source
// at streamerbot/actions/scene-themer-poll.cs. GUIDs are derived from a
// fixed seed so re-running produces the same bundle (re-importing into SB
// upgrades the existing action instead of duplicating).
//
// Run:
//   node streamerbot/build-scene-themer-bundle.js
//
// The resulting bundle.json is imported via Streamer.bot Settings, Import.
// SB also accepts the encoded .sb.txt magic-header form; if we ever ship
// that variant, tools/build-sb-import.ps1 is the canonical pipeline (see
// loadout-import.sb.txt next to loadout-import.bundle.json).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const CS_PATH = path.join(ROOT, "streamerbot", "actions", "scene-themer-poll.cs");
const OUT_PATH = path.join(ROOT, "streamerbot", "scene-themer-import.bundle.json");

function deterministicGuid(seed) {
  const h = crypto.createHash("sha1").update(seed).digest();
  const b = Buffer.from(h.slice(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20, 32),
  ].join("-");
}

function main() {
  const cs = fs.readFileSync(CS_PATH, "utf8");
  const byteCode = Buffer.from(cs, "utf8").toString("base64");

  const actionId    = deterministicGuid("aquilo:scene-themer:action:v1");
  const triggerId   = deterministicGuid("aquilo:scene-themer:trigger:v1");
  const subActionId = deterministicGuid("aquilo:scene-themer:subaction:v1");

  const bundle = {
    meta: {
      name: "Aquilo Scene Themer",
      author: "aquiloplays",
      version: "1.0.0",
      description: "Polls aquilo.gg for the active scene group based on your current Twitch category, toggles OBS source group visibility. Configure mappings at https://aquilo.gg/scene-themer.",
      autoRunAction: null,
      minimumVersion: null,
    },
    manifest: {
      product: "Aquilo Scene Themer for Streamer.bot",
      packageVersion: "1.0.0",
      group: "Aquilo",
      generatedBy: "streamerbot/build-scene-themer-bundle.js",
      actionCount: 1,
      actions: ["Aquilo Scene Themer Poll"],
      commands: [],
      includes: ["scene-themer-poll"],
    },
    data: {
      actions: [{
        id: actionId,
        queue: "00000000-0000-0000-0000-000000000000",
        enabled: true,
        excludeFromHistory: true,
        excludeFromPending: true,
        name: "Aquilo Scene Themer Poll",
        group: "Aquilo",
        alwaysRun: false,
        randomAction: false,
        concurrent: false,
        triggers: [{
          id: triggerId,
          type: 701,
          enabled: true,
          exclusions: [],
        }],
        subActions: [{
          name: "Aquilo Scene Themer: poll + apply",
          description: "GET /api/scene-themer/active/<broadcaster>, toggles ObsSetSourceVisibility for each group.",
          references: [
            "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\mscorlib.dll",
            "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\System.dll",
            "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\System.Core.dll",
            "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\System.Web.Extensions.dll",
          ],
          byteCode,
          precompile: false,
          delayStart: false,
          saveResultToVariable: false,
          saveToVariable: "",
          id: subActionId,
          weight: 0,
          type: 99999,
          parentId: null,
          enabled: true,
          index: 0,
        }],
        collapsedGroups: [],
      }],
      timers: [{
        id: triggerId,
        name: "Aquilo Scene Themer Tick",
        enabled: true,
        intervalSeconds: 10,
        onlyWhenLive: false,
        actionId,
      }],
    },
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(bundle, null, 4));
  console.log("Wrote", path.relative(ROOT, OUT_PATH));
}

main();
