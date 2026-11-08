# Cleaned ENR snapshot series, Texas general election 2026-11-03

One file per committed version of `state/results.csv` on `enr-2026` (102 versions, 2026-11-04 00:51:53 to 2026-11-05 05:41:04 UTC), in the same schema. File names are `<commit time>_<enr-2026 commit>.csv`, as written by `enr/recover.sh`. The raw record on `enr-2026` is unchanged.

Two corrections, made by `enr/R/clean_series.R`:

- `county_fips` comes from `county_name` through `enr/county_fips.csv` (letters-only uppercase key). The recorder had derived it from the SOS county number, which put MADISON through MAVERICK before MCCULLOCH and gave nine counties the wrong FIPS.
- Transient double counts are masked. A county x office is flagged in a snapshot when any candidate's `votes` or `votes_early` exceeds that candidate's final value by more than 2,500 votes. Its `votes`, `votes_early`, `race_votes_county` and `precincts_reporting` are replaced with the values from its last good snapshot. `flags.csv` lists every flagged county x office x snapshot; `windows.csv` groups them into runs, with `cleared_utc` the first good snapshot after each run.

Gates: every county name matched, rows aligned across snapshots, final snapshot unchanged, no missing votes, 102 snapshots in and out, and exactly STARR, UPSHUR, DALLAS, GUADALUPE and FORT BEND flagged for the Senate.

Rebuilt with:

    enr/recover.sh enr-2026 <recovered>
    Rscript enr/R/clean_series.R <recovered>/results <out>
