# enr_estimate.R
suppressPackageStartupMessages({ library(dplyr); library(stringr); library(jsonlite) })

BATCH_SD    <- 0.04     # sd of a partial count's 2P share around the county's final share, at zero counted
NOISE_FLOOR <- 0.002
MIN_OBS     <- 50       # two-party votes before a county part enters the update
TURN_K      <- 200000   # prior weight (Election Day votes) on a statewide Election Day turnout factor of 1
ROBUST_SD   <- 0.015    # extra statewide 2P shift allowed once votes are counted (07 itself may be off)
N_POST      <- 10000L
SEED_POST   <- 20261103L

ckey <- function(x) str_remove_all(toupper(x), "[^A-Z]")   # county join key, letters only (LASALLE = LA SALLE)

prep_pack <- function(pack) {
  ct <- pack$draws$talarico; cp <- pack$draws$paxton; cb <- pack$draws$brown
  tot <- ct + cp + cb
  s   <- ct / pmax(ct + cp, 1)
  cty <- pack$county
  E   <- cty$ev_banked * (1 - pack$priors$rolloff) * cty$enr_over_roster
  N_mean <- rowMeans(tot)
  bf  <- cb / pmax(tot, 1)
  sw2p <- colSums(ct) / colSums(ct + cp)                                   # statewide 2P share per draw
  beta <- as.numeric(cov(t(s), sw2p)) / var(sw2p)                          # county loading on the statewide share
  list(cty = cty, tot = tot, s = s, m = rowMeans(s), S = cov(t(s)), beta = beta,
       bf = bf, brown = rowMeans(bf), E = E, N_mean = N_mean, f = pmin(E / N_mean, 0.99),
       gam = cty$gap_dev, gap_sd = cty$gap_sd,
       G0 = pack$priors$gap_center, G_sd = pack$priors$gap_sd, p07 = pack$p_talarico_07)
  # enr_estimate.R
  suppressPackageStartupMessages({ library(dplyr); library(stringr); library(jsonlite) })
  
  BATCH_SD    <- 0.04     # sd of a partial count's 2P share around the county's final share, at zero counted
  NOISE_FLOOR <- 0.002
  MIN_OBS     <- 50       # two-party votes before a county part enters the update
  TURN_K      <- 200000   # prior weight (Election Day votes) on a statewide Election Day turnout factor of 1
  ROBUST_SD   <- 0.015    # extra statewide 2P shift allowed once votes are counted (07 itself may be off)
  N_POST      <- 10000L
  SEED_POST   <- 20261103L
  
  ckey <- function(x) str_remove_all(toupper(x), "[^A-Z]")   # county join key, letters only (LASALLE = LA SALLE)
  
  prep_pack <- function(pack) {
    ct <- pack$draws$talarico; cp <- pack$draws$paxton; cb <- pack$draws$brown
    tot <- ct + cp + cb
    s   <- ct / pmax(ct + cp, 1)
    cty <- pack$county
    E   <- cty$ev_banked * (1 - pack$priors$rolloff) * cty$enr_over_roster
    N_mean <- rowMeans(tot)
    bf  <- cb / pmax(tot, 1)
    sw2p <- colSums(ct) / colSums(ct + cp)                                   # statewide 2P share per draw
    beta <- as.numeric(cov(t(s), sw2p)) / var(sw2p)                          # county loading on the statewide share
    list(cty = cty, tot = tot, s = s, m = rowMeans(s), S = cov(t(s)), beta = beta,
         bf = bf, brown = rowMeans(bf), E = E, N_mean = N_mean, f = pmin(E / N_mean, 0.99),
         gam = cty$gap_dev, gap_sd = cty$gap_sd,
         G0 = pack$priors$gap_center, G_sd = pack$priors$gap_sd, p07 = pack$p_talarico_07)
  }
  
  senate_obs <- function(res) {
    if (!"precincts_reporting" %in% names(res)) res$precincts_reporting <- NA
    if (!"precincts_total" %in% names(res)) res$precincts_total <- NA
    mx <- function(x) { x <- suppressWarnings(as.numeric(x)); if (all(is.na(x))) NA_real_ else max(x, na.rm = TRUE) }
    res |>
      filter(office_type == "FD", str_squish(office_name) == "U. S. SENATOR") |>
      mutate(key = ckey(county_name), v = as.numeric(votes), ev = as.numeric(votes_early),
             grp = case_when(cand_party == "DEM" ~ "d", cand_party == "REP" ~ "r", TRUE ~ "o")) |>
      group_by(key) |>
      summarise(ev_d = sum(ev[grp == "d"]), ev_r = sum(ev[grp == "r"]), ev_o = sum(ev[grp == "o"]),
                ed_d = sum(v[grp == "d"] - ev[grp == "d"]), ed_r = sum(v[grp == "r"] - ev[grp == "r"]),
                ed_o = sum(v[grp == "o"] - ev[grp == "o"]),
                pr = mx(precincts_reporting), tp = mx(precincts_total), .groups = "drop")
  }
  
  estimate_live <- function(P, obs, seed = SEED_POST, n_post = N_POST) {
    k <- nrow(P$cty)
    key <- ckey(P$cty$county)
    stopifnot(!anyDuplicated(key), all(obs$key %in% key))
    al    <- function(col) { v <- obs[[col]][match(key, obs$key)]; ifelse(is.na(v), 0, v) }
    al_na <- function(col) if (is.null(obs[[col]])) rep(NA_real_, k) else obs[[col]][match(key, obs$key)]
    ev_d <- al("ev_d"); ev_r <- al("ev_r"); ev_o <- al("ev_o")
    ed_d <- al("ed_d"); ed_r <- al("ed_r"); ed_o <- al("ed_o")
    ev_n <- ev_d + ev_r + ev_o; ed_n <- ed_d + ed_r + ed_o
    pr <- al_na("pr"); tp <- al_na("tp")
    done  <- !is.na(pr) & !is.na(tp) & tp > 0 & pr >= tp & (ev_n + ed_n) > 0   # county fully reported
    ED_mean <- pmax(P$N_mean - P$E, 1)
    fac     <- (sum(ed_n[done]) + TURN_K) / (sum(ED_mean[done]) + TURN_K)          # statewide Election Day turnout factor
    w_pace  <- ifelse(!done & !is.na(pr) & !is.na(tp) & tp > 0 & pr > 0, pmin(pr / tp, 1), 0)
    ED_pace <- ifelse(w_pace > 0, ed_n / pmax(w_pace, 1e-9), 0)                     # county Election Day total at its reporting pace
    ED_hat  <- ifelse(done, ed_n, w_pace * ED_pace + (1 - w_pace) * ED_mean * fac)
    N_hat   <- ifelse(done, ev_n + ed_n, pmax(P$E + ED_hat, ev_n + ed_n))
    f <- pmin(pmax(ifelse(done, ev_n / pmax(ev_n + ed_n, 1), P$E / N_hat), 0.01), 0.99)   # actual early fraction once done
    ED_exp  <- pmax(N_hat - P$E, 1)
    frac_ev <- ifelse(done, 1, pmin(ev_n / P$E, 1)); frac_ed <- ifelse(done, 1, pmin(ed_n / ED_exp, 1))
    
    # Gaussian update of (county 2P shares, statewide early-minus-ED gap)
    i_ev <- which(ev_d + ev_r >= MIN_OBS); i_ed <- which(ed_d + ed_r >= MIN_OBS)
    no <- length(i_ev) + length(i_ed)
    tau <- if (any(ev_n + ed_n > 0)) ROBUST_SD else 0                         # robustness only once counting starts
    mu <- c(P$m, P$G0)
    P0 <- matrix(0, k + 1, k + 1); P0[1:k, 1:k] <- P$S + tau^2 * outer(P$beta, P$beta); P0[k + 1, k + 1] <- P$G_sd^2
    if (no > 0) {
      cc  <- c(i_ev, i_ed)
      isv <- c(rep(TRUE, length(i_ev)), rep(FALSE, length(i_ed)))
      n2  <- ifelse(isv, ev_d[cc] + ev_r[cc], ed_d[cc] + ed_r[cc])
      y   <- ifelse(isv, ev_d[cc], ed_d[cc]) / n2
      lam <- ifelse(isv, 1 - f[cc], -f[cc])
      frc <- ifelse(isv, frac_ev[cc], frac_ed[cc])
      H <- matrix(0, no, k + 1)
      H[cbind(seq_len(no), cc)] <- 1
      H[, k + 1] <- lam
      off <- lam * P$gam[cc]
      R <- diag((BATCH_SD * (1 - frc))^2 + NOISE_FLOOR^2 + y * (1 - y) / n2, no)
      gs <- lam * P$gap_sd[cc]
      R <- R + outer(cc, cc, "==") * outer(gs, gs)
      Sg <- H %*% P0 %*% t(H) + R
      K  <- P0 %*% t(H) %*% solve(Sg)
      post_mu <- as.numeric(mu + K %*% (y - H %*% mu - off))
      post_P  <- P0 - K %*% H %*% P0
      post_P  <- (post_P + t(post_P)) / 2
    } else { post_mu <- mu; post_P <- P0; K <- NULL }
    
    # final counts: 07's own draws moved by the same gain (ensemble Kalman), each keeping its turnout draw
    set.seed(seed)
    j  <- ((seq_len(n_post) - 1L) %% ncol(P$tot)) + 1L
    Xp <- rbind(P$s[, j, drop = FALSE], rnorm(n_post, P$G0, P$G_sd))
    if (tau > 0) Xp[1:k, ] <- Xp[1:k, , drop = FALSE] + outer(P$beta, rnorm(n_post, 0, tau))   # same extra shift in the draws
    if (!is.null(K)) {
      E_obs <- t(chol(R)) %*% matrix(rnorm(no * n_post), no, n_post)
      Xp <- Xp + K %*% (y + E_obs - H %*% Xp - off)
    }
    s <- pmin(pmax(Xp[1:k, , drop = FALSE], 0.01), 0.99)
    G <- Xp[k + 1, ]
    D <- P$gam + matrix(G, k, n_post, byrow = TRUE) + matrix(rnorm(k * n_post), k, n_post) * P$gap_sd
    sev <- pmin(pmax(s + (1 - f) * D, 0.01), 0.99)
    sed <- pmin(pmax(s - f * D, 0.01), 0.99)
    tot <- P$tot[, j, drop = FALSE]
    Ed     <- pmin(P$E, tot)                                                # early part never exceeds the draw's own total
    rem_ev <- pmax(Ed - ev_n, 0) * !done                                    # nothing left in fully reported counties
    ED_tot <- w_pace * ED_pace + (1 - w_pace) * pmax(tot - Ed, 0) * fac      # each draw's Election Day, learned from turnout so far
    rem_ed <- pmax(ED_tot - ed_n, 0) * !done
    w2p <- 1 - P$bf[, j, drop = FALSE]                                     # each draw's own Brown share by county
    tal_c <- (ev_d + ed_d) + rem_ev * w2p * sev + rem_ed * w2p * sed
    pax_c <- (ev_r + ed_r) + rem_ev * w2p * (1 - sev) + rem_ed * w2p * (1 - sed)
    all_c <- (ev_n + ed_n) + rem_ev + rem_ed
    tal <- colSums(tal_c); pax <- colSums(pax_c); total <- colSums(all_c)
    tal2p <- tal / (tal + pax)
    counted <- sum(ev_n + ed_n)
    q <- function(x, p) unname(quantile(x, p))
    obs_2p <- ifelse(ev_d + ev_r + ed_d + ed_r > 0, (ev_d + ed_d) / (ev_d + ev_r + ed_d + ed_r), NA_real_)
    est_2p <- ifelse(done, obs_2p, post_mu[1:k])                              # finished counties show their actual share
    
    list(
      statewide = list(
        p_talarico = mean(tal > pax), p_talarico_prior = P$p07,
        tal_2p_mean = mean(tal2p), tal_2p_q10 = q(tal2p, .1), tal_2p_q90 = q(tal2p, .9),
        margin_mean = mean(tal - pax), margin_q10 = q(tal - pax, .1), margin_q90 = q(tal - pax, .9),
        votes_counted = counted, votes_expected = mean(total), pct_counted = counted / mean(total),
        counties_reporting = sum(ev_n + ed_n > 0), counties_complete = sum(done), update_rows = no,
        eday_turnout_factor = fac, robust_sd = tau,
        early_gap_mean = post_mu[k + 1], early_gap_sd = sqrt(post_P[k + 1, k + 1])),
      counties = tibble(
        fips3 = P$cty$fips3, county = P$cty$county, county_num = P$cty$county_num,
        counted_early = ev_n, counted_eday = ed_n, complete = done, expected_total = rowMeans(all_c),
        pct_counted = (ev_n + ed_n) / rowMeans(all_c), early_banked = P$E,
        obs_2p_early = ifelse(ev_d + ev_r > 0, ev_d / (ev_d + ev_r), NA_real_),
        obs_2p_eday  = ifelse(ed_d + ed_r > 0, ed_d / (ed_d + ed_r), NA_real_),
        prior_2p = P$m, post_2p = est_2p, post_2p_sd = ifelse(done, 0, sqrt(pmax(diag(post_P)[1:k], 0))),
        shift = est_2p - P$m, p_talarico = rowMeans(tal_c > pax_c))
    )
  }
  
  if (sys.nframe() == 0L) {
    a <- commandArgs(trailingOnly = TRUE)
    if (length(a) < 3) stop("usage: Rscript enr_estimate.R <pack.rds> <results.csv> <live_dir>", call. = FALSE)
    P   <- prep_pack(readRDS(a[1]))
    res <- read.csv(a[2], colClasses = "character")
    out <- estimate_live(P, senate_obs(res))
    snap <- if ("snapshot_utc" %in% names(res) && nrow(res)) max(res$snapshot_utc) else format(Sys.time(), tz = "UTC", usetz = TRUE)
    out$statewide$snapshot_utc <- snap
    dir.create(a[3], showWarnings = FALSE, recursive = TRUE)
    write_json(out, file.path(a[3], "live.json"), auto_unbox = TRUE, digits = 6, na = "null")
    tp   <- file.path(a[3], "trajectory.json")
    traj <- if (file.exists(tp)) fromJSON(tp, simplifyDataFrame = FALSE) else list()
    keep <- c("snapshot_utc", "p_talarico", "tal_2p_mean", "tal_2p_q10", "tal_2p_q90",
              "margin_mean", "votes_counted", "pct_counted", "counties_reporting", "counties_complete", "early_gap_mean", "eday_turnout_factor")
    if (!length(traj) || !identical(traj[[length(traj)]]$snapshot_utc, snap))
      traj[[length(traj) + 1L]] <- out$statewide[keep]
    write_json(traj, tp, auto_unbox = TRUE, digits = 6)
  }
}
