use super::*;

impl<'f> Pass<'f> {
    /// `processSeriesMember`, in the original A/B orientation of the match.
    pub(super) fn member(
        &mut self,
        [series_index, member_index]: [usize; 2],
        series: &'f SeriesFrame,
        member: &'f Member,
        series_final: bool,
        by_team: &ByTeam,
        local: &mut [Option<f64>],
    ) -> Result<MemberTrail> {
        let model = self.model;
        let frame = self.frame;
        let result = by_team.result;
        let strength = by_team.strength;
        let initial = model.initial_team_rating;
        let sides = &member.sides;
        let team = [sides[0].team, sides[1].team];
        let league = [sides[0].league, sides[1].league];
        let side_adjustment = [sides[0].side_adjustment.0, sides[1].side_adjustment.0];
        let pick = |s: usize, values: [Bits; 2], default: f64| {
            if series_final {
                by_team.get(team[s], values, default)
            } else {
                default
            }
        };

        let rating = team.map(|t| bits(frame.teams[t].rating).unwrap_or(initial));
        let execution = team.map(|t| local[t].unwrap_or(initial));
        let league_score = league.map(|l| self.snapshot_league(l));
        let power = [0, 1].map(|s| model.power_rating(rating[s], league_score[s]));
        let execution_power = [0, 1].map(|s| model.power_rating(execution[s], league_score[s]));
        let offset = [0, 1].map(|s| {
            model.roster_prior_offset(
                bits(sides[s].player_adjustment),
                bits(frame.teams[team[s]].roster_prior_offset),
            )
        });
        let wins = team.map(|t| self.teams.wins.num(t).unwrap_or(0.0));
        let losses = team.map(|t| self.teams.losses.num(t).unwrap_or(0.0));
        let published_offset = [
            model.published_roster_prior(offset[0], wins[0], losses[0])?,
            model.published_roster_prior(offset[1], wins[1], losses[1])?,
        ];
        let momentum = team.map(|t| bits(frame.teams[t].momentum).unwrap_or(0.0));
        let live_rating_before = team.map(|t| self.teams.rating.num(t).unwrap_or(initial));
        let live_league_before = league.map(|l| self.live_league(l));
        let live_momentum_before = team.map(|t| self.teams.momentum.num(t).unwrap_or(0.0));
        let live_uncertainty_before = team.map(|t| {
            self.teams
                .uncertainty
                .num(t)
                .unwrap_or(model.maximum_uncertainty)
        });
        let previous_components = [
            model.components(
                live_rating_before[0],
                live_league_before[0],
                published_offset[0],
                live_momentum_before[0],
                live_uncertainty_before[0],
            )?,
            model.components(
                live_rating_before[1],
                live_league_before[1],
                published_offset[1],
                live_momentum_before[1],
                live_uncertainty_before[1],
            )?,
        ];
        let previous_display = previous_components.each_ref().map(display);
        let current_power = [0, 1].map(|s| power[s] + offset[s] + momentum[s]);
        let effective_rating = [0, 1].map(|s| current_power[s] + side_adjustment[s]);
        let execution_effective =
            [0, 1].map(|s| execution_power[s] + offset[s] + momentum[s] + side_adjustment[s]);
        let event_k = member.event_k.0;
        let game_k = event_k / f64::from(series.best_of).sqrt();
        let a_won = member.winner == 0;
        let residual =
            [0, 1].map(|s| pick(s, [result.series_residual_a, result.series_residual_b], 0.0));
        let evidence = [0, 1].map(|s| {
            pick(
                s,
                [
                    result.series_result_evidence_a,
                    result.series_result_evidence_b,
                ],
                0.0,
            )
        });
        let base_stable = [0, 1].map(|s| {
            pick(
                s,
                [result.base_stable_delta_a, result.base_stable_delta_b],
                0.0,
            )
        });
        let base_form =
            [0, 1].map(|s| pick(s, [result.base_form_delta_a, result.base_form_delta_b], 0.0));
        let base_league = [0, 1].map(|s| {
            pick(
                s,
                [result.base_league_delta_a, result.base_league_delta_b],
                0.0,
            )
        });
        let uncertainty_multiplier = [0, 1].map(|s| {
            pick(
                s,
                [
                    result.uncertainty_multiplier_a,
                    result.uncertainty_multiplier_b,
                ],
                1.0,
            )
        });
        let roster_multiplier = [0, 1].map(|s| {
            pick(
                s,
                [result.roster_multiplier_a, result.roster_multiplier_b],
                1.0,
            )
        });
        let delta = [0, 1].map(|s| pick(s, [result.series_delta_a, result.series_delta_b], 0.0));
        let final_value = |value: Bits| if series_final { value.0 } else { 0.0 };
        let ledger_stable_share = [
            final_value(result.applied_team_stable_share_a),
            final_value(result.applied_team_stable_share_b),
        ];
        let ledger_form_share = final_value(result.team_form_share);
        let ledger_league_share = final_value(result.league_signal_share);
        let ledger_strength = if series_final { strength } else { 0.0 };
        let transfer = [
            result.stable_transfer_weight_a.0,
            result.stable_transfer_weight_b.0,
        ];
        let execution_index = [
            model.execution_index(&stats(&sides[0]), &stats(&sides[1])),
            model.execution_index(&stats(&sides[1]), &stats(&sides[0])),
        ];
        let expected_a = expected_score(execution_effective[0], execution_effective[1]);
        let execution_expected = [expected_a, 1.0 - expected_a];
        let execution_outcome = [
            model.execution_soft_outcome(if a_won { 1.0 } else { 0.0 }, execution_index[0]),
            model.execution_soft_outcome(if a_won { 0.0 } else { 1.0 }, execution_index[1]),
        ];
        let execution_delta = [0, 1].map(|s| {
            js_round(
                game_k
                    * model.rating_update_recency_weight
                    * (execution_outcome[s] - execution_expected[s]),
            )
        });

        for s in 0..2 {
            self.teams
                .previous_display
                .set(team[s], previous_display[s]);
        }
        for s in 0..2 {
            self.teams.rating.add_delta(team[s], delta[s], initial);
        }
        for s in 0..2 {
            local[team[s]] = Some(execution[s] + execution_delta[s]);
        }
        for s in 0..2 {
            self.teams
                .execution
                .add_delta(team[s], execution_delta[s], initial);
        }
        for s in 0..2 {
            self.teams.roster_prior.set(team[s], offset[s]);
        }
        let next_uncertainty = [0, 1].map(|s| {
            if series_final {
                model.next_uncertainty(
                    live_uncertainty_before[s],
                    event_k,
                    league[s] != league[1 - s] && member.international,
                )
            } else {
                live_uncertainty_before[s]
            }
        });
        for s in 0..2 {
            self.teams.uncertainty.set(team[s], next_uncertainty[s]);
        }
        let league_delta = if series_final {
            self.league_update(member, by_team, team, league, current_power, base_league)?
        } else {
            [0.0, 0.0]
        };
        for s in 0..2 {
            self.apply_league_delta(league[s], league_delta[s]);
        }
        let updated_league = league.map(|l| self.live_league(l));
        let mut league_history = Vec::new();
        if series_final
            && by_team.observed[0] != by_team.observed[1]
            && !(league_delta[0] == 0.0 && league_delta[1] == 0.0)
        {
            for (s, score) in updated_league.into_iter().enumerate() {
                league_history.push(self.league_point(member, [s, 1 - s], score, league_delta)?);
            }
        }
        let live_rating_after = team.map(|t| self.teams.rating.num(t).unwrap_or(initial));
        let league_adjustment =
            [0, 1].map(|s| model.league_adjustment(live_rating_after[s], updated_league[s]));
        let updated_momentum = [0, 1].map(|s| {
            if series_final {
                clamp(
                    live_momentum_before[s] * model.momentum_game_decay + base_form[s],
                    -model.momentum_cap,
                    model.momentum_cap,
                )
            } else {
                live_momentum_before[s]
            }
        });
        for s in 0..2 {
            self.teams.momentum.set(team[s], updated_momentum[s]);
        }
        let won = [a_won, !a_won];
        let record = |value: f64, add: bool| {
            if series_final {
                value + if add { 1.0 } else { 0.0 }
            } else {
                value
            }
        };
        let updated_offset = [
            model.published_roster_prior(
                offset[0],
                record(wins[0], won[0]),
                record(losses[0], !won[0]),
            )?,
            model.published_roster_prior(
                offset[1],
                record(wins[1], won[1]),
                record(losses[1], !won[1]),
            )?,
        ];
        let components = [
            model.components(
                live_rating_after[0],
                updated_league[0],
                updated_offset[0],
                updated_momentum[0],
                next_uncertainty[0],
            )?,
            model.components(
                live_rating_after[1],
                updated_league[1],
                updated_offset[1],
                updated_momentum[1],
                next_uncertainty[1],
            )?,
        ];
        let display_rating = [display(&components[0]), display(&components[1])];
        let shares = &model.latent_strength_result_budget_shares;
        let mut ledgers = Vec::with_capacity(2);
        for s in 0..2 {
            let mut unavailable_channels = BASE_UNAVAILABLE_CHANNELS.to_vec();
            if transfer[s] < 1.0 {
                unavailable_channels.push(TRANSFER_SHRUNK_CHANNEL);
            }
            ledgers.push(Ledger {
                team_stable_delta: Bits(fixed(delta[s], 1)?),
                league_game_delta: Bits(fixed(league_delta[s], 1)?),
                league_placement_delta: Bits(fixed(0.0, 1)?),
                momentum_delta: Bits(fixed(updated_momentum[s] - live_momentum_before[s], 1)?),
                roster_prior_delta: Bits(fixed(0.0, 1)?),
                uncertainty_delta: Bits(fixed(
                    next_uncertainty[s] - live_uncertainty_before[s],
                    1,
                )?),
                side_adjustment: Bits(fixed(side_adjustment[s], 1)?),
                patch_adjustment: Bits(fixed(0.0, 1)?),
                rating_target: "context-neutral-latent-team-strength",
                update_unit: if series_final {
                    "series-atomic"
                } else {
                    "series-member-no-team-update"
                },
                event_weight: Bits(fixed(member.event_weight.0, 3)?),
                result_evidence: Bits(fixed(evidence[s], 1)?),
                base_team_stable_delta: Bits(fixed(base_stable[s], 1)?),
                base_team_form_delta: Bits(fixed(base_form[s], 1)?),
                base_league_delta: Bits(fixed(base_league[s], 1)?),
                uncertainty_multiplier: Bits(fixed(uncertainty_multiplier[s], 3)?),
                roster_volatility_multiplier: Bits(fixed(roster_multiplier[s], 3)?),
                stable_transfer_weight: Bits(fixed(transfer[s], 3)?),
                neutral_result_residual: Bits(fixed(residual[s], 3)?),
                series_strength_signal: Bits(fixed(ledger_strength, 3)?),
                team_stable_share: Bits(fixed(ledger_stable_share[s], 2)?),
                team_form_share: Bits(fixed(ledger_form_share, 2)?),
                player_signal_share: Bits(fixed(shares.player_signal_shadow, 2)?),
                lineup_signal_share: Bits(fixed(shares.lineup_signal_shadow, 2)?),
                league_signal_share: Bits(fixed(ledger_league_share, 2)?),
                direct_region_signal_share: Bits(fixed(shares.direct_region_shadow, 2)?),
                player_signal_delta: Bits(fixed(evidence[s] * shares.player_signal_shadow, 1)?),
                lineup_signal_delta: Bits(fixed(evidence[s] * shares.lineup_signal_shadow, 1)?),
                direct_region_signal_delta: Bits(fixed(
                    evidence[s] * shares.direct_region_shadow,
                    1,
                )?),
                unavailable_channels,
            });
        }
        for (s, team) in team.into_iter().enumerate() {
            self.teams.latest_update.set(
                team,
                Source::Member {
                    series: series_index,
                    member: member_index,
                    side: s,
                },
            );
        }
        let history_delta = [0, 1].map(|s| {
            if series_final {
                display_rating[s] - previous_display[s]
            } else {
                0.0
            }
        });
        for s in 0..2 {
            self.record(team[s], won[s]);
        }
        let factors = [0, 1].map(|s| Factors {
            context: Bits(normalize(event_k, 12.0, 34.0)),
            recency: Bits(self.recency),
            execution: Bits(if won[s] { 1.0 } else { 0.0 }),
            opponent: Bits(normalize(effective_rating[1 - s], 1350.0, 1700.0)),
            league: Bits(normalize(
                league_score[s] + js_max(0.0, league_delta[s]),
                1440.0,
                1560.0,
            )),
        });
        for s in 0..2 {
            self.add_factors(team[s], &factors[s]);
        }
        let touched = self.record_side_sample(member);
        for s in 0..2 {
            self.record_team_context(member, [series_index, member_index, s]);
        }
        self.processed += 1.0;

        let mut ledgers = ledgers.into_iter();
        let mut trails = Vec::with_capacity(2);
        for s in 0..2 {
            let t = team[s];
            trails.push(SideTrail {
                snapshot_rating: Bits(rating[s]),
                local_execution_before: Bits(execution[s]),
                snapshot_league_score: Bits(league_score[s]),
                snapshot_momentum: Bits(momentum[s]),
                power_rating: Bits(power[s]),
                execution_power_rating: Bits(execution_power[s]),
                current_power_rating: Bits(current_power[s]),
                effective_rating: Bits(effective_rating[s]),
                execution_effective_rating: Bits(execution_effective[s]),
                live_rating_before: Bits(live_rating_before[s]),
                live_league_before: Bits(live_league_before[s]),
                live_momentum_before: Bits(live_momentum_before[s]),
                live_uncertainty_before: Bits(live_uncertainty_before[s]),
                previous_components: previous_components[s].clone(),
                execution_index: Bits(execution_index[s]),
                execution_expected: Bits(execution_expected[s]),
                execution_outcome: Bits(execution_outcome[s]),
                execution_delta: Bits(execution_delta[s]),
                local_execution_rating: local[t].map(Bits),
                execution_rating: self.teams.execution.bits(t),
                rating: self.teams.rating.bits(t),
                series_delta: Bits(delta[s]),
                previous_display_rating: self.teams.previous_display.bits(t),
                roster_prior_offset: self.teams.roster_prior.bits(t),
                published_roster_prior_offset: Bits(published_offset[s]),
                updated_roster_prior_offset: Bits(updated_offset[s]),
                uncertainty: self.teams.uncertainty.bits(t),
                momentum: self.teams.momentum.bits(t),
                league_delta: Bits(league_delta[s]),
                updated_league_score: Bits(updated_league[s]),
                display_rating: Bits(display_rating[s]),
                history_delta: Bits(history_delta[s]),
                history: HistoryValues {
                    rating: Bits(js_round(display_rating[s])),
                    base_rating: Bits(js_round(live_rating_after[s])),
                    league_adjustment: Bits(league_adjustment[s]),
                    side_adjustment: Bits(side_adjustment[s]),
                    delta: Bits(js_round(history_delta[s])),
                    result: outcome(won[s]),
                },
                components: components[s].clone(),
                latest_rating_update: ledgers.next().ok_or("missing ledger")?,
                factors: factors[s],
                factor_sums: self.teams.factor_sums.get(t).copied(),
                factor_count: self.teams.factor_count.bits(t),
                wins: self.teams.wins.bits(t),
                losses: self.teams.losses.bits(t),
                form: self.teams.form.get(t).cloned(),
                last_patch: self.teams.last_patch.get(t).cloned(),
                last_roster: self.teams.last_roster.get(t).map(|(source, _)| *source),
                last_roster_fingerprint: self.teams.last_fingerprint.get(t).cloned(),
                league: self.league_state(league[s]),
            });
        }
        let mut trails = trails.into_iter();
        Ok(MemberTrail {
            series_final,
            game_k: Bits(game_k),
            recency: Bits(self.recency),
            sides: [
                trails.next().ok_or("missing side trail")?,
                trails.next().ok_or("missing side trail")?,
            ],
            league_history,
            side_samples: touched,
            processed_match_count: Bits(self.processed),
        })
    }
}
