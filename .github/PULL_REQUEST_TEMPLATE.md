<!-- Thanks for the PR. Brief is fine — we read every line. -->

## What changed

(One paragraph or a bullet list. Why is this needed?)

## Type

- [ ] New module / feature
- [ ] Bug fix
- [ ] Refactor / cleanup
- [ ] Docs / config change only
- [ ] Build / CI / release tooling

## Testing

- [ ] `dotnet build src/Loadout.Core/Loadout.Core.csproj -c Release` succeeds with 0 warnings, 0 errors
- [ ] `tools/build-sb-import.ps1` succeeds and `tools/decode-sb-export.ps1` round-trips the output
- [ ] Manually exercised the new behavior in a live or simulated SB session
- [ ] Updated `CONFIG.md` / `CHANGELOG.md` if user-facing settings or behavior changed

## Notes for the reviewer

(Anything counterintuitive about the implementation, alternatives you considered, follow-ups needed.)
