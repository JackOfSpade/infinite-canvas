import application_bundle_links from './tests/application-bundle-links.js';
import application_unit_patches from './tests/application-unit-patches.js';
import application_render_faults from './tests/application-render-faults.js';
import application_rule_tally from './tests/application-rule-tally.js';
import fs from 'node:fs';
import base64 from './tests/base64.js';
import marketplace_monitor from './tests/marketplace-monitor.js';
import ai_models from './tests/ai-models.js';
import fixtures_canvas from './tests/fixtures-canvas.js';
import job_diagnostics from './tests/job-diagnostics.js';
import job_scoring_cache from './tests/job-scoring-cache.js';
import marketplace_extractors_auth from './tests/marketplace-extractors-auth.js';
import jobs_location_language from './tests/jobs-location-language.js';
import job_source_country_scope from './tests/job-source-country-scope.js';
import job_collection_scope_caveats from './tests/job-collection-scope-caveats.js';
import marketplace_diagnostics_locks from './tests/marketplace-diagnostics-locks.js';
import platform_utils from './tests/platform-utils.js';
import skill_opportunities from './tests/skill-opportunities.js';
import resume_download_bundle from './tests/resume-download-bundle.js';
import application_edit_log from './tests/application-edit-log.js';
import career_import_log from './tests/career-import-log.js';
import application_generation_gate from './tests/application-generation-gate.js';
import application_multi_posting from './tests/application-multi-posting.js';
import cover_letter_harness from './tests/cover-letter-harness.js';
import job_collection_limits from './tests/job-collection-limits.js';
import job_search_queries from './tests/job-search-queries.js';
import electron_regressions from './tests/electron-regressions.js';
import renderer_content_security from './tests/renderer-content-security.js';
import local_ai_application from './tests/local-ai-application.js';
import application_authority_ledger_store from './tests/application-authority-ledger-store.js';
import current_authority_parallel_match from './tests/current-authority-parallel-match.js';
import application_career_authority from './tests/application-career-authority.js';
import application_write_verify from './tests/application-write-verify.js';
import official_posting_gates from './tests/official-posting-gates.js';
import official_posting_r2_subject from './tests/official-posting-r2-subject.js';
import official_posting_r3_identities from './tests/official-posting-r3-identities.js';
import official_posting_r3_fetch_session from './tests/official-posting-r3-fetch-session.js';
import official_posting_r3_resolver from './tests/official-posting-r3-resolver.js';
import official_posting_r3_service from './tests/official-posting-r3-service.js';
import official_posting_r3_recovery from './tests/official-posting-r3-recovery.js';
import official_posting_r4_bundle from './tests/official-posting-r4-bundle.js';
import official_posting_r4_ui from './tests/official-posting-r4-ui.js';
import official_posting_r4_skills from './tests/official-posting-r4-skills.js';
import official_posting_r4_generation from './tests/official-posting-r4-generation.js';
import official_posting_r2_guard from './tests/official-posting-r2-guard.js';
import official_posting_r2_binding from './tests/official-posting-r2-binding.js';
import official_posting_r2_closing from './tests/official-posting-r2-closing.js';
import official_posting_skills from './tests/official-posting-skills.js';
import official_posting_skill_selection from './tests/official-posting-skill-selection.js';
import official_posting_fetch from './tests/official-posting-fetch.js';
import official_posting_store from './tests/official-posting-store.js';
import official_posting_match from './tests/official-posting-match.js';
import official_posting_extractors from './tests/official-posting-extractors.js';
import official_posting_resolver from './tests/official-posting-resolver.js';
import official_posting_resilience from './tests/official-posting-resilience.js';
import official_posting_r1_parsing from './tests/official-posting-r1-parsing.js';
import official_posting_r1_legacy_binding from './tests/official-posting-r1-legacy-binding.js';
import official_posting_match_integrity from './tests/official-posting-match-integrity.js';
import official_posting_amendment3 from './tests/official-posting-amendment3.js';
import official_posting_board_closed from './tests/official-posting-board-closed.js';
import listing_liveness from './tests/listing-liveness.js';
import listing_liveness_linkedin_dice from './tests/listing-liveness-linkedin-dice.js';
import listing_liveness_telemetry from './tests/listing-liveness-telemetry.js';
import listing_liveness_capture from './tests/listing-liveness-capture.js';
import listing_liveness_registry from './tests/listing-liveness-registry.js';
import listing_liveness_ai from './tests/listing-liveness-ai.js';
import listing_liveness_transport from './tests/listing-liveness-transport.js';
import listing_liveness_alternates from './tests/listing-liveness-alternates.js';
import listing_liveness_search_handler from './tests/listing-liveness-search-handler.js';
import listing_liveness_search_session from './tests/listing-liveness-search-session.js';
import listing_liveness_calibration_store from './tests/listing-liveness-calibration-store.js';
import listing_liveness_bundle from './tests/listing-liveness-bundle.js';
import listing_liveness_generation from './tests/listing-liveness-generation.js';
import official_source_hosts from './tests/official-source-hosts.js';
import official_posting_fields from './tests/official-posting-fields.js';
import official_posting_scrape from './tests/official-posting-scrape.js';
import official_posting_bridge from './tests/official-posting-bridge.js';
import official_posting_service from './tests/official-posting-service.js';
import official_posting_search from './tests/official-posting-search.js';
import official_posting_consumers from './tests/official-posting-consumers.js';
import official_posting_freeze from './tests/official-posting-freeze.js';
import official_posting_bundle from './tests/official-posting-bundle.js';
import official_posting_generation from './tests/official-posting-generation.js';
import official_posting_ui from './tests/official-posting-ui.js';
import official_posting_audit from './tests/official-posting-audit.js';
import official_posting_audit_staging from './tests/official-posting-audit-staging.js';
import official_posting_closing from './tests/official-posting-closing.js';
import official_posting_closing_assembly from './tests/official-posting-closing-assembly.js';
import cover_letter_hedged_diagnosis from './tests/cover-letter-hedged-diagnosis.js';
import claude_application_runner from './tests/claude-application-runner.js';
import claude_application_sdk_stage from './tests/claude-application-sdk-stage.js';
import application_editorial_plan from './tests/application-editorial-plan.js';
import application_editorial_plan_archive from './tests/application-editorial-plan-archive.js';
import claude_application_diagnostics from './tests/claude-application-diagnostics.js';
import handoff_bridge_application_executor from './tests/handoff-bridge-application-executor.js';
import application_claude_dock from './tests/application-claude-dock.js';
import claude_job_progress from './tests/claude-job-progress.js';
import application_v2_writer_shortlist from './tests/application-v2-writer-shortlist.js';
import paste_application_assembly from './tests/paste-application-assembly.js';
import paste_application_flow from './tests/paste-application-flow.js';
import paste_application_fit_save from './tests/paste-application-fit-save.js';
import local_ai_deletion from './tests/local-ai-deletion.js';
import login_url_markers from './tests/login-url-markers.js';
import compensation_assessment from './tests/compensation-assessment.js';
import personal_salary_recommendation from './tests/personal-salary-recommendation.js';
import job_compensation_pipeline from './tests/job-compensation-pipeline.js';
import job_location_lookup from './tests/job-location-lookup.js';
import job_location_consolidation from './tests/job-location-consolidation.js';
import job_search_locations from './tests/job-search-locations.js';
import job_title_match from './tests/job-title-match.js';
import job_posted_date from './tests/job-posted-date.js';
import job_search_date_window from './tests/job-search-date-window.js';
import job_board_provider from './tests/job-board-provider.js';
import job_fit_assessment from './tests/job-fit-assessment.js';
import auth_cookie_checkpoint from './tests/auth-cookie-checkpoint.js';
import browser_launch_lock_regression from './tests/browser-launch-lock-regression.js';
import schema_validation from './tests/schema-validation.js';
import validation_failure from './tests/validation-failure.js';
import job_resume_ingestion from './tests/job-resume-ingestion.js';
import job_scoring_evidence from './tests/job-scoring-evidence.js';
import job_analysis_operation_ledger from './tests/job-analysis-operation-ledger.js';
import job_analysis_operation_authority_adversarial from './tests/job-analysis-operation-authority-adversarial.js';
import job_continuation_authority_contract from './tests/job-continuation-authority-contract.js';
import career_canvas_file_import from './tests/career-canvas-file-import.js';
import job_board_canvas_career_drop from './tests/job-board-canvas-career-drop.js';
import career_text_files from './tests/career-text-files.js';
import career_profile_compilation from './tests/career-profile-compilation.js';
import career_incremental_compilation from './tests/career-incremental-compilation.js';
import career_clean_layer from './tests/career-clean-layer.js';
import career_profile_edits from './tests/career-profile-edits.js';
import non_api_ai from './tests/non-api-ai.js';
import job_workflow_documentation from './tests/job-workflow-documentation.js';
import job_run_staging from './tests/job-run-staging.js';
import job_autoresume_recovery from './tests/job-autoresume-recovery.js';
import job_board_recovery_notice from './tests/job-board-recovery-notice.js';
import job_board_action_visibility from './tests/job-board-action-visibility.js';
import job_board_career_override from './tests/job-board-career-override.js';
import job_board_career_override_ui from './tests/job-board-career-override-ui.js';
import job_search_split_clear from './tests/job-search-split-clear.js';
import job_card_review_bucket from './tests/job-card-review-bucket.js';
import job_gap_review from './tests/job-gap-review.js';
import validator_correction_details from './tests/validator-correction-details.js';
import job_search_clear_ui from './tests/job-search-clear-ui.js';
import job_board_combine_receipt from './tests/job-board-combine-receipt.js';
import job_api_probe from './tests/job-api-probe.js';
import application_pdf_reconcile from './tests/application-pdf-reconcile.js';
import packaging_integrity from './tests/packaging-integrity.js';
import solve_ipc_failure from './tests/solve-ipc-failure.js';
import nested_canvas_absorption from './tests/nested-canvas-absorption.js';
import job_role_lock_regressions from './tests/job-role-lock-regressions.js';
import application_handoff_dock from './tests/application-handoff-dock.js';
import paste_identity_guard from './tests/paste-identity-guard.js';
import paste_review_delta from './tests/paste-review-delta.js';
import event_log_deletion_batching from './tests/event-log-deletion-batching.js';
import handoff_bridge_inert from './tests/handoff-bridge-inert.js';
import handoff_bridge_http from './tests/handoff-bridge-http.js';
import handoff_bridge_mcp from './tests/handoff-bridge-mcp.js';
import handoff_bridge_oauth from './tests/handoff-bridge-oauth.js';
import handoff_bridge_engine from './tests/handoff-bridge-engine.js';
import handoff_bridge_application from './tests/handoff-bridge-application.js';
import handoff_bridge_push from './tests/handoff-bridge-push.js';
import non_api_ai_bridge_seam from './tests/non-api-ai-bridge-seam.js';
import handoff_bridge_store from './tests/handoff-bridge-store.js';
import handoff_bridge_tunnel from './tests/handoff-bridge-tunnel.js';
import handoff_bridge_controls from './tests/handoff-bridge-controls.js';
import handoff_bridge_ipc from './tests/handoff-bridge-ipc.js';
import handoff_bridge_privacy from './tests/handoff-bridge-privacy.js';
import handoff_bridge_hostile from './tests/handoff-bridge-hostile.js';
import handoff_bridge_source_scan from './tests/handoff-bridge-source-scan.js';
import handoff_bridge_ui from './tests/handoff-bridge-ui.js';
import handoff_chat_launcher from './tests/handoff-chat-launcher.js';
import handoff_bridge_render from './tests/handoff-bridge-render.js';
import handoff_bridge_canvas_orphan from './tests/handoff-bridge-canvas-orphan.js';
import issue_reporter from './tests/issue-reporter.js';
import search_bar_render from './tests/search-bar-render.js';
import network_rolling_scheduler from './tests/network-rolling-scheduler.js';
import handoff_scheduler from './tests/handoff-scheduler.js';
import application_slot_queue from './tests/application-slot-queue.js';
import application_bundle_watch from './tests/application-bundle-watch.js';
import application_sync_lifecycle from './tests/application-sync-lifecycle.js';
import quit_autosave from './tests/quit-autosave.js';
import job_tree_user_arranged_layout from './tests/job-tree-user-arranged-layout.js';
import job_card_bundle_indicator from './tests/job-card-bundle-indicator.js';
import handoff_bridge_application_pool_growth from './tests/handoff-bridge-application-pool-growth.js';
import application_bridge_page from './tests/application-bridge-page.js';
import application_bridge_page_render from './tests/application-bridge-page-render.js';
import application_bridge_page_dock from './tests/application-bridge-page-dock.js';
import application_authority_workflow from './tests/application-authority-workflow.js';
import one_card_live_acceptance from './tests/one-card-live-acceptance.js';
import pointer_occlusion_probe from './tests/pointer-occlusion-probe.js';
import test_runner_watchdog from './tests/test-runner-watchdog.js';
import interview_helper from './tests/interview-helper.js';
import interview_helper_privacy from './tests/interview-helper-privacy.js';
import interview_helper_render from './tests/interview-helper-render.js';
import interview_private_store_filesystem from './tests/interview-private-store-filesystem.js';
import interview_preparation from './tests/interview-preparation.js';
import interview_preload from './tests/interview-preload.js';
import interview_window from './tests/interview-window.js';
import interview_window_render from './tests/interview-window-render.js';
import career_recovery_resume from './tests/career-recovery-resume.js';
import adaptability_skills from './tests/adaptability-skills.js';
import adaptability_metrics from './tests/adaptability-metrics.js';
import adaptability_dates from './tests/adaptability-dates.js';
import adaptability_ownership from './tests/adaptability-ownership.js';
import adaptability_relationships from './tests/adaptability-relationships.js';
import adaptability_listing from './tests/adaptability-listing.js';
import gapfix_claim_grounding from './tests/gapfix-claim-grounding.js';
import gapfix_letter_evidence from './tests/gapfix-letter-evidence.js';
import gapfix_career_validators from './tests/gapfix-career-validators.js';
import gapfix_letter_proportion from './tests/gapfix-letter-proportion.js';
import gapfix_grounding_locality from './tests/gapfix-grounding-locality.js';
import gapfix_transfer_budget from './tests/gapfix-transfer-budget.js';
import gapfix_host_owned_fields from './tests/gapfix-host-owned-fields.js';
import gapfix_v16_claim_budget from './tests/gapfix-v16-claim-budget.js';
import gapfix_v16_prompts from './tests/gapfix-v16-prompts.js';
import gapfix_v16_repair_brief from './tests/gapfix-v16-repair-brief.js';
import gapfix_v16_resume_dates from './tests/gapfix-v16-resume-dates.js';
import gapfix_v16_verb_fidelity from './tests/gapfix-v16-verb-fidelity.js';
import gapfix_v16b_closing_authorship from './tests/gapfix-v16b-closing-authorship.js';
import gapfix_v16b_contract_consistency from './tests/gapfix-v16b-contract-consistency.js';
import gapfix_v16b_letter_truthfulness from './tests/gapfix-v16b-letter-truthfulness.js';
import gapfix_v16b_relevance_budget from './tests/gapfix-v16b-relevance-budget.js';
import gapfix_v16b_verb_fidelity from './tests/gapfix-v16b-verb-fidelity.js';
import gapfix_v16c_closing_gate from './tests/gapfix-v16c-closing-gate.js';
import gapfix_v16c_letter_binding from './tests/gapfix-v16c-letter-binding.js';
import gapfix_v16c_letter_functions from './tests/gapfix-v16c-letter-functions.js';
import gapfix_v16c_requirement_modality from './tests/gapfix-v16c-requirement-modality.js';
import gapfix_v16c_verb_fidelity from './tests/gapfix-v16c-verb-fidelity.js';
import gapfix_v17_resume_dispositions from './tests/gapfix-v17-resume-dispositions.js';
import gapfix_v17_letter_dispositions from './tests/gapfix-v17-letter-dispositions.js';
import gapfix_v17_truth_recall from './tests/gapfix-v17-truth-recall.js';
import expense_outcome_contractions from './tests/expense-outcome-contractions.js';
import offline_simulator from './tests/offline-simulator.js';
import oracle_leak_gate from './tests/oracle-leak-gate.js';

// Keep the file name beside its group so omissions and stale registrations
// fail before a green test run gives a false signal.
const testGroups = [
  ['base64.js', base64],
  ['marketplace-monitor.js', marketplace_monitor],
  ['ai-models.js', ai_models],
  ['fixtures-canvas.js', fixtures_canvas],
  ['job-diagnostics.js', job_diagnostics],
  ['job-scoring-cache.js', job_scoring_cache],
  ['marketplace-extractors-auth.js', marketplace_extractors_auth],
  ['jobs-location-language.js', jobs_location_language],
  ['job-source-country-scope.js', job_source_country_scope],
  ['job-collection-scope-caveats.js', job_collection_scope_caveats],
  ['marketplace-diagnostics-locks.js', marketplace_diagnostics_locks],
  ['platform-utils.js', platform_utils],
  ['skill-opportunities.js', skill_opportunities],
  ['resume-download-bundle.js', resume_download_bundle],
  ['application-edit-log.js', application_edit_log],
  ['career-import-log.js', career_import_log],
  ['application-generation-gate.js', application_generation_gate],
  ['application-multi-posting.js', application_multi_posting],
  ['cover-letter-harness.js', cover_letter_harness],
  ['job-collection-limits.js', job_collection_limits],
  ['job-search-queries.js', job_search_queries],
  ['electron-regressions.js', electron_regressions],
  ['renderer-content-security.js', renderer_content_security],
  ['local-ai-application.js', local_ai_application],
  ['application-authority-ledger-store.js', application_authority_ledger_store],
  ['current-authority-parallel-match.js', current_authority_parallel_match],
  ['application-career-authority.js', application_career_authority],
  ['application-write-verify.js', application_write_verify],
  ['official-posting-gates.js', official_posting_gates],
  ['official-posting-r2-subject.js', official_posting_r2_subject],
  ['official-posting-r3-identities.js', official_posting_r3_identities],
  ['official-posting-r3-fetch-session.js', official_posting_r3_fetch_session],
  ['official-posting-r3-resolver.js', official_posting_r3_resolver],
  ['official-posting-r3-service.js', official_posting_r3_service],
  ['official-posting-r3-recovery.js', official_posting_r3_recovery],
  ['official-posting-r4-bundle.js', official_posting_r4_bundle],
  ['official-posting-r4-ui.js', official_posting_r4_ui],
  ['official-posting-r4-skills.js', official_posting_r4_skills],
  ['official-posting-r4-generation.js', official_posting_r4_generation],
  ['official-posting-r2-guard.js', official_posting_r2_guard],
  ['official-posting-r2-binding.js', official_posting_r2_binding],
  ['official-posting-r2-closing.js', official_posting_r2_closing],
  ['official-posting-skills.js', official_posting_skills],
  ['official-posting-skill-selection.js', official_posting_skill_selection],
  ['official-posting-fetch.js', official_posting_fetch],
  ['official-posting-store.js', official_posting_store],
  ['official-posting-match.js', official_posting_match],
  ['official-posting-extractors.js', official_posting_extractors],
  ['official-posting-resolver.js', official_posting_resolver],
  ['official-posting-resilience.js', official_posting_resilience],
  ['official-posting-r1-parsing.js', official_posting_r1_parsing],
  ['official-posting-r1-legacy-binding.js', official_posting_r1_legacy_binding],
  ['official-posting-match-integrity.js', official_posting_match_integrity],
  ['official-posting-amendment3.js', official_posting_amendment3],
  ['official-posting-board-closed.js', official_posting_board_closed],
  ['listing-liveness.js', listing_liveness],
  ['listing-liveness-linkedin-dice.js', listing_liveness_linkedin_dice],
  ['listing-liveness-telemetry.js', listing_liveness_telemetry],
  ['listing-liveness-capture.js', listing_liveness_capture],
  ['listing-liveness-registry.js', listing_liveness_registry],
  ['listing-liveness-ai.js', listing_liveness_ai],
  ['listing-liveness-transport.js', listing_liveness_transport],
  ['listing-liveness-alternates.js', listing_liveness_alternates],
  ['listing-liveness-search-handler.js', listing_liveness_search_handler],
  ['listing-liveness-search-session.js', listing_liveness_search_session],
  ['listing-liveness-calibration-store.js', listing_liveness_calibration_store],
  ['listing-liveness-bundle.js', listing_liveness_bundle],
  ['listing-liveness-generation.js', listing_liveness_generation],
  ['official-source-hosts.js', official_source_hosts],
  ['official-posting-fields.js', official_posting_fields],
  ['official-posting-scrape.js', official_posting_scrape],
  ['official-posting-bridge.js', official_posting_bridge],
  ['official-posting-service.js', official_posting_service],
  ['official-posting-search.js', official_posting_search],
  ['official-posting-consumers.js', official_posting_consumers],
  ['official-posting-freeze.js', official_posting_freeze],
  ['official-posting-bundle.js', official_posting_bundle],
  ['official-posting-generation.js', official_posting_generation],
  ['official-posting-ui.js', official_posting_ui],
  ['official-posting-audit.js', official_posting_audit],
  ['official-posting-audit-staging.js', official_posting_audit_staging],
  ['official-posting-closing.js', official_posting_closing],
  ['official-posting-closing-assembly.js', official_posting_closing_assembly],
  ['application-unit-patches.js', application_unit_patches],
  ['application-rule-tally.js', application_rule_tally],
  ['application-render-faults.js', application_render_faults],
  ['cover-letter-hedged-diagnosis.js', cover_letter_hedged_diagnosis],
  ['claude-application-runner.js', claude_application_runner],
  ['claude-application-sdk-stage.js', claude_application_sdk_stage],
  ['application-editorial-plan.js', application_editorial_plan],
  ['application-editorial-plan-archive.js', application_editorial_plan_archive],
  ['claude-application-diagnostics.js', claude_application_diagnostics],
  ['handoff-bridge-application-executor.js', handoff_bridge_application_executor],
  ['application-claude-dock.js', application_claude_dock],
  ['claude-job-progress.js', claude_job_progress],
  ['application-v2-writer-shortlist.js', application_v2_writer_shortlist],
  ['paste-application-assembly.js', paste_application_assembly],
  ['paste-application-flow.js', paste_application_flow],
  ['paste-application-fit-save.js', paste_application_fit_save],
  ['local-ai-deletion.js', local_ai_deletion],
  ['login-url-markers.js', login_url_markers],
  ['compensation-assessment.js', compensation_assessment],
  ['personal-salary-recommendation.js', personal_salary_recommendation],
  ['application-bundle-links.js', application_bundle_links],
  ['job-compensation-pipeline.js', job_compensation_pipeline],
  ['job-location-lookup.js', job_location_lookup],
  ['job-location-consolidation.js', job_location_consolidation],
  ['job-search-locations.js', job_search_locations],
  ['job-title-match.js', job_title_match],
  ['job-posted-date.js', job_posted_date],
  ['job-search-date-window.js', job_search_date_window],
  ['job-board-provider.js', job_board_provider],
  ['job-fit-assessment.js', job_fit_assessment],
  ['auth-cookie-checkpoint.js', auth_cookie_checkpoint],
  ['browser-launch-lock-regression.js', browser_launch_lock_regression],
  ['schema-validation.js', schema_validation],
  ['validation-failure.js', validation_failure],
  ['job-resume-ingestion.js', job_resume_ingestion],
  ['job-scoring-evidence.js', job_scoring_evidence],
  ['job-analysis-operation-ledger.js', job_analysis_operation_ledger],
  ['job-analysis-operation-authority-adversarial.js', job_analysis_operation_authority_adversarial],
  ['job-continuation-authority-contract.js', job_continuation_authority_contract],
  ['career-canvas-file-import.js', career_canvas_file_import],
  ['job-board-canvas-career-drop.js', job_board_canvas_career_drop],
  ['career-text-files.js', career_text_files],
  ['career-profile-compilation.js', career_profile_compilation],
  ['career-incremental-compilation.js', career_incremental_compilation],
  ['career-clean-layer.js', career_clean_layer],
  ['career-profile-edits.js', career_profile_edits],
  ['non-api-ai.js', non_api_ai],
  ['job-workflow-documentation.js', job_workflow_documentation],
  ['job-run-staging.js', job_run_staging],
  ['job-autoresume-recovery.js', job_autoresume_recovery],
  ['job-board-recovery-notice.js', job_board_recovery_notice],
  ['job-board-action-visibility.js', job_board_action_visibility],
  ['job-board-career-override.js', job_board_career_override],
  ['job-board-career-override-ui.js', job_board_career_override_ui],
  ['job-search-split-clear.js', job_search_split_clear],
  ['job-card-review-bucket.js', job_card_review_bucket],
  ['job-gap-review.js', job_gap_review],
  ['validator-correction-details.js', validator_correction_details],
  ['job-search-clear-ui.js', job_search_clear_ui],
  ['job-board-combine-receipt.js', job_board_combine_receipt],
  ['job-api-probe.js', job_api_probe],
  ['application-pdf-reconcile.js', application_pdf_reconcile],
  ['packaging-integrity.js', packaging_integrity],
  ['solve-ipc-failure.js', solve_ipc_failure],
  ['nested-canvas-absorption.js', nested_canvas_absorption],
  ['job-role-lock-regressions.js', job_role_lock_regressions],
  ['application-handoff-dock.js', application_handoff_dock],
  ['paste-identity-guard.js', paste_identity_guard],
  ['paste-review-delta.js', paste_review_delta],
  ['event-log-deletion-batching.js', event_log_deletion_batching],
  ['handoff-bridge-inert.js', handoff_bridge_inert],
  ['handoff-bridge-http.js', handoff_bridge_http],
  ['handoff-bridge-mcp.js', handoff_bridge_mcp],
  ['handoff-bridge-oauth.js', handoff_bridge_oauth],
  ['handoff-bridge-engine.js', handoff_bridge_engine],
  ['handoff-bridge-application.js', handoff_bridge_application],
  ['handoff-bridge-push.js', handoff_bridge_push],
  ['non-api-ai-bridge-seam.js', non_api_ai_bridge_seam],
  ['handoff-bridge-store.js', handoff_bridge_store],
  ['handoff-bridge-tunnel.js', handoff_bridge_tunnel],
  ['handoff-bridge-controls.js', handoff_bridge_controls],
  ['handoff-bridge-ipc.js', handoff_bridge_ipc],
  ['handoff-bridge-privacy.js', handoff_bridge_privacy],
  ['handoff-bridge-hostile.js', handoff_bridge_hostile],
  ['handoff-bridge-source-scan.js', handoff_bridge_source_scan],
  ['handoff-bridge-ui.js', handoff_bridge_ui],
  ['handoff-chat-launcher.js', handoff_chat_launcher],
  ['handoff-bridge-render.js', handoff_bridge_render],
  ['handoff-bridge-canvas-orphan.js', handoff_bridge_canvas_orphan],
  ['issue-reporter.js', issue_reporter],
  ['search-bar-render.js', search_bar_render],
  ['network-rolling-scheduler.js', network_rolling_scheduler],
  ['handoff-scheduler.js', handoff_scheduler],
  ['application-slot-queue.js', application_slot_queue],
  ['application-bundle-watch.js', application_bundle_watch],
  ['application-sync-lifecycle.js', application_sync_lifecycle],
  ['quit-autosave.js', quit_autosave],
  ['job-tree-user-arranged-layout.js', job_tree_user_arranged_layout],
  ['job-card-bundle-indicator.js', job_card_bundle_indicator],
  ['handoff-bridge-application-pool-growth.js', handoff_bridge_application_pool_growth],
  ['application-bridge-page.js', application_bridge_page],
  ['application-bridge-page-render.js', application_bridge_page_render],
  ['application-bridge-page-dock.js', application_bridge_page_dock],
  ['application-authority-workflow.js', application_authority_workflow],
  ['one-card-live-acceptance.js', one_card_live_acceptance],
  ['pointer-occlusion-probe.js', pointer_occlusion_probe],
  ['test-runner-watchdog.js', test_runner_watchdog],
  ['interview-helper.js', interview_helper],
  ['interview-helper-privacy.js', interview_helper_privacy],
  ['interview-helper-render.js', interview_helper_render],
  ['interview-private-store-filesystem.js', interview_private_store_filesystem],
  ['interview-preparation.js', interview_preparation],
  ['interview-preload.js', interview_preload],
  ['interview-window.js', interview_window],
  ['interview-window-render.js', interview_window_render],
  ['career-recovery-resume.js', career_recovery_resume],
  ['adaptability-skills.js', adaptability_skills],
  ['adaptability-metrics.js', adaptability_metrics],
  ['adaptability-dates.js', adaptability_dates],
  ['adaptability-ownership.js', adaptability_ownership],
  ['adaptability-relationships.js', adaptability_relationships],
  ['adaptability-listing.js', adaptability_listing],
  ['gapfix-claim-grounding.js', gapfix_claim_grounding],
  ['gapfix-letter-evidence.js', gapfix_letter_evidence],
  ['gapfix-career-validators.js', gapfix_career_validators],
  ['gapfix-letter-proportion.js', gapfix_letter_proportion],
  ['gapfix-grounding-locality.js', gapfix_grounding_locality],
  ['gapfix-transfer-budget.js', gapfix_transfer_budget],
  ['gapfix-host-owned-fields.js', gapfix_host_owned_fields],
  ['gapfix-v16-claim-budget.js', gapfix_v16_claim_budget],
  ['gapfix-v16-prompts.js', gapfix_v16_prompts],
  ['gapfix-v16-repair-brief.js', gapfix_v16_repair_brief],
  ['gapfix-v16-resume-dates.js', gapfix_v16_resume_dates],
  ['gapfix-v16-verb-fidelity.js', gapfix_v16_verb_fidelity],
  ['gapfix-v16b-closing-authorship.js', gapfix_v16b_closing_authorship],
  ['gapfix-v16b-contract-consistency.js', gapfix_v16b_contract_consistency],
  ['gapfix-v16b-letter-truthfulness.js', gapfix_v16b_letter_truthfulness],
  ['gapfix-v16b-relevance-budget.js', gapfix_v16b_relevance_budget],
  ['gapfix-v16b-verb-fidelity.js', gapfix_v16b_verb_fidelity],
  ['gapfix-v16c-closing-gate.js', gapfix_v16c_closing_gate],
  ['gapfix-v16c-letter-binding.js', gapfix_v16c_letter_binding],
  ['gapfix-v16c-letter-functions.js', gapfix_v16c_letter_functions],
  ['gapfix-v16c-requirement-modality.js', gapfix_v16c_requirement_modality],
  ['gapfix-v16c-verb-fidelity.js', gapfix_v16c_verb_fidelity],
  ['gapfix-v17-resume-dispositions.js', gapfix_v17_resume_dispositions],
  ['gapfix-v17-letter-dispositions.js', gapfix_v17_letter_dispositions],
  ['gapfix-v17-truth-recall.js', gapfix_v17_truth_recall],
  ['expense-outcome-contractions.js', expense_outcome_contractions],
  ['offline-simulator.js', offline_simulator],
  ['oracle-leak-gate.js', oracle_leak_gate],
];

// Unit tests are normally short, but a suspended Promise otherwise lets Node
// drain the event loop and exit before the runner has printed a failure
// summary. Keep a referenced watchdog around every test. The default is
// deliberately generous; a slow, legitimate test can opt into a longer budget
// with TEST_RUNNER_TIMEOUT_MS=<positive integer>.
const DEFAULT_TEST_TIMEOUT_MS = 120_000;

function readTestTimeoutMs(value = process.env.TEST_RUNNER_TIMEOUT_MS) {
  if (value === undefined || value === '') return DEFAULT_TEST_TIMEOUT_MS;
  if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    throw new Error('TEST_RUNNER_TIMEOUT_MS must be a positive integer number of milliseconds');
  }
  return Number(value);
}

function watchdogFixtureGroups() {
  // A narrow, process-only seam used by the runner regression. It keeps the
  // normal registry immutable while testing the exact failure mode that used
  // to silently terminate a run.
  if (process.env.TEST_RUNNER_SELFTEST !== 'never-settles') return testGroups;
  return [[
    'watchdog-fixture.js',
    [
      { name: 'test runner watchdog fixture: never settles', run: () => new Promise(() => {}) },
      { name: 'test runner watchdog fixture: continues after timeout', run: () => ({ continued: true }) },
    ],
  ]];
}

function validateTestRegistry(groups) {
  const testDirectory = new URL('./tests/', import.meta.url);
  const discoveredFiles = fs.readdirSync(testDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'testHelpers.js')
    .map((entry) => entry.name)
    .sort();
  const registeredFiles = groups.map(([file]) => file);
  const registeredSet = new Set(registeredFiles);
  const problems = [];
  const unregistered = discoveredFiles.filter((file) => !registeredSet.has(file));
  const stale = registeredFiles.filter((file) => !discoveredFiles.includes(file));
  const duplicateFiles = registeredFiles.filter((file, index) => registeredFiles.indexOf(file) !== index);

  if (unregistered.length) problems.push(`unregistered test file(s): ${unregistered.join(', ')}`);
  if (stale.length) problems.push(`missing test file(s): ${stale.join(', ')}`);
  if (duplicateFiles.length) problems.push(`duplicate test registration(s): ${[...new Set(duplicateFiles)].join(', ')}`);

  const names = new Set();
  for (const [file, group] of groups) {
    if (!Array.isArray(group)) {
      problems.push(`${file} must default-export an array of tests`);
      continue;
    }
    if (group.length === 0) {
      problems.push(`${file} must declare at least one test`);
      continue;
    }
    for (const test of group) {
      if (!test || typeof test.name !== 'string' || !test.name || typeof test.run !== 'function') {
        problems.push(`${file} contains an invalid test declaration`);
        continue;
      }
      if (names.has(test.name)) problems.push(`duplicate test name: ${test.name}`);
      names.add(test.name);
    }
  }

  if (problems.length) throw new Error(`Test registry invalid: ${problems.join('; ')}`);
  return groups;
}

function captureTestConsole() {
  const levels = ['log', 'warn', 'error'];
  const original = Object.fromEntries(levels.map(level => [level, console[level]]));
  const entries = [];
  for (const level of levels) {
    console[level] = (...args) => entries.push({ level, args });
  }
  return {
    restore() {
      for (const level of levels) console[level] = original[level];
    },
    replay() {
      for (const { level, args } of entries) original[level]('[TEST OUTPUT]', ...args);
    },
    count: () => entries.length,
  };
}

function runTestWithWatchdog(test, { file, timeoutMs }) {
  let timer;
  const timeout = new Promise((_, reject) => {
    // Do not call unref(): this timer is what prevents Node from treating a
    // suspended test as a successful, naturally-complete process.
    timer = setTimeout(() => {
      const error = new Error(`timed out after ${timeoutMs}ms`);
      error.name = 'TestTimeoutError';
      error.testFile = file;
      error.testName = test.name;
      reject(error);
    }, timeoutMs);
  });
  const execution = Promise.resolve().then(() => test.run());
  return Promise.race([execution, timeout]).finally(() => clearTimeout(timer));
}

async function run() {
  let passed = 0;
  let failed = 0;
  // Always check the real registry, even when the narrow watchdog fixture is
  // selected in a child process. The fixture should not weaken registration
  // coverage for the normal unit suite.
  validateTestRegistry(testGroups);
  const groups = watchdogFixtureGroups();
  const verbose = process.env.TEST_VERBOSE === '1';
  const timeoutMs = readTestTimeoutMs();

  console.log(`\n[TEST RUNNER] Deterministic smoke tests (${groups.length} groups)\n`);

  for (const [file, tests] of groups) {
    let groupPassed = 0;
    for (const test of tests) {
      const capturedConsole = captureTestConsole();
      try {
        const details = await runTestWithWatchdog(test, { file, timeoutMs });
        capturedConsole.restore();
        if (verbose) console.log(`PASS ${test.name}`, details ? JSON.stringify(details) : '');
        passed++;
        groupPassed++;
      } catch (error) {
        capturedConsole.restore();
        console.error(`FAIL ${file} :: ${test.name}:`, error.stack || error.message);
        if (capturedConsole.count() > 0) capturedConsole.replay();
        failed++;
      }
    }
    const status = groupPassed === tests.length ? 'PASS' : 'FAIL';
    const write = status === 'PASS' ? console.log : console.error;
    write(`${status} ${file} (${groupPassed}/${tests.length} tests)`);
  }

  console.log(`\n[TEST RUNNER] ${passed} passed, ${failed} failed`);
  summaryPrinted = true;
  // Only now is a green result earned; until here the exit code stays failing.
  process.exitCode = failed > 0 ? 1 : 0;
}

// A test whose promise never settles lets the event loop drain, and Node then
// exits quietly with the code it already holds. Start failing and clear that
// only after the summary prints, so an unfinished run can never look green.
let summaryPrinted = false;
process.exitCode = 1;
process.on('exit', () => {
  if (summaryPrinted) return;
  process.exitCode = 1;
  // process.stderr, not console: a hung test never restores the captured console.
  process.stderr.write('[TEST RUNNER] Exited before the summary: a test never settled (or the runner crashed). Treating the run as FAILED.\n');
});

run().catch((error) => {
  console.error('[TEST RUNNER] Fatal error:', error);
  process.exitCode = 1;
});
