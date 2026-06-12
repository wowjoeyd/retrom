# Emulator User Data Sync Validation

Use this checklist for release and regression validation of managed emulator user
data sync. Run with two desktop clients pointed at the same Retrom server and NAS.

## Cross-PC Scenarios

- [ ] RPCS3 firmware: install firmware on PC A, Play or Push, then Play on PC B
      without reinstalling firmware.
- [ ] RPCS3 RAPs and installed PKG: install two titles and RAPs on PC A, Push,
      Pull on PC B, then launch both titles.
- [ ] Switch keys and NAND: add keys/internal install content on PC A, Push, then
      verify Eden/Citron/Ryubing on PC B can launch without repeating setup.
- [ ] Bidirectional update: add user data on PC B after PC A pushed, Push from PC
      B, then Pull/Play on PC A.
- [ ] Conflict modal: create different local/cloud versions, verify cloud/local
      choices work and remembered preference is shown.
- [ ] Version carry: link a newer package version and verify missing user-data
      files copy from the old cache without deleting old-version files.

## Analyzer And Overrides

- [ ] Empty overrides fall back to catalog manifest paths.
- [ ] Custom overrides replace manifest paths for push/pull/prune decisions.
- [ ] Analyzer suggests top-level firmware/key/install paths when
      `EMULATOR_USER_DATA_ENHANCED=true`.
- [ ] Analyzer UI is hidden when `EMULATOR_USER_DATA_ENHANCED=false`.

## Performance And Safety

- [ ] Repeated Play after an unchanged large user-data tree skips most hashing via
      `sync_state.json.user_data_files`.
- [ ] A tree over `EMULATOR_USER_DATA_LARGE_WARNING_BYTES` logs a warning.
- [ ] A walk over `EMULATOR_USER_DATA_MAX_WALK_FILES` stops and logs the cap.
- [ ] Empty `user_data_paths` performs no auto-push.
- [ ] Direct emulator launches outside Retrom do not push until the next Retrom
      Play, explicit Push, or enabled app-start background sync.

## Suggested Measurements

- First Play after adding 10 GB user data: record push duration and uploaded byte
  count.
- Second Play with no changes: record ensure duration and confirm no uploaded
  files.
- Play after changing one RAP/key file: confirm only the changed file uploads.
