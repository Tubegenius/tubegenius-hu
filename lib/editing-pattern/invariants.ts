// lib/editing-pattern/invariants.ts
// The structural invariants every EditingAnalysisResult with metrics must satisfy. Used twice: the analyzer
// refuses to hand out a result that breaks them (a defensive `failed` / `invariant_violation`), and the tests
// run it as a property over every fixture and over randomised inputs.
import { COMPLETE_COVERAGE_RATIO, type ContractIssue, type EditingAnalysisResult } from './contract'

export function checkEditingResultInvariants(result: EditingAnalysisResult): ContractIssue[] {
  const issues: ContractIssue[] = []
  const add = (path: string, code: string) => issues.push({ path, code })
  const metrics = result.metrics
  if (result.status !== 'complete' && result.status !== 'partial') {
    if (metrics !== null) add('metrics', 'metrics_without_a_measurement_status')
    return issues
  }
  if (!metrics || !result.coverage) {
    add('metrics', 'missing_metrics')
    return issues
  }
  const duration = result.coverage.declared_duration_ms

  const ratio = result.coverage.coverage_ratio
  if (!(ratio >= 0 && ratio <= 1)) add('coverage.coverage_ratio', 'out_of_range')
  if (Math.abs(result.coverage.covered_ms + result.coverage.uncovered_ms - duration) > 0.01) add('coverage', 'covered_plus_uncovered_differs_from_duration')
  // the emitted ratio is the exact ratio truncated to 3 decimals: never above it, and less than 0.001 below it
  const exact = result.coverage.covered_ms / duration
  if (ratio > exact + 1e-6 || exact - ratio >= 0.001 + 1e-6) add('coverage.coverage_ratio', 'differs_from_covered_time')
  if (result.coverage.gap_total_ms > result.coverage.uncovered_ms + 0.01) add('coverage.gap_total_ms', 'exceeds_the_uncovered_time')
  if (result.status === 'complete' && ratio < COMPLETE_COVERAGE_RATIO) add('status', 'complete_below_the_coverage_threshold')
  if (metrics.scope.covers_full_duration) {
    if (result.status !== 'complete') add('metrics.scope.covers_full_duration', 'full_duration_without_complete_status')
    if (result.coverage.gaps.length > 0 || result.coverage.gap_total_ms > 0) add('metrics.scope.covers_full_duration', 'full_duration_with_holes')
    if (result.coverage.uncovered_ms > 0.001) add('metrics.scope.covers_full_duration', 'full_duration_with_uncovered_time')
    if (metrics.scope.to_ms !== duration) add('metrics.scope.to_ms', 'full_duration_but_scope_ends_early')
  }

  let previous = 0
  result.cuts.forEach((cut, i) => {
    if (!(cut.t_ms > 0 && cut.t_ms < duration)) add(`cuts[${i}].t_ms`, 'outside_the_video')
    if (i > 0 && cut.t_ms <= result.cuts[i - 1].t_ms) add(`cuts[${i}].t_ms`, 'not_increasing')
  })

  if (!result.shots_truncated) {
    if (result.shots.length !== result.cuts.length + 1) add('shots', 'shot_count_differs_from_cuts_plus_one')
    result.shots.forEach((shot, i) => {
      if (!(shot.duration_ms > 0)) add(`shots[${i}].duration_ms`, 'not_positive')
      if (shot.end_ms - shot.start_ms !== shot.duration_ms) add(`shots[${i}].duration_ms`, 'differs_from_start_end')
      if (shot.start_ms !== previous) add(`shots[${i}].start_ms`, 'not_contiguous')
      previous = shot.end_ms
    })
    if (result.shots.length && result.shots[result.shots.length - 1].end_ms !== metrics.scope.to_ms) add('shots', 'does_not_reach_the_scope_end')
  }
  if (metrics.shot_count !== metrics.cut_count + 1) add('metrics.shot_count', 'differs_from_cut_count_plus_one')
  if (metrics.cut_count !== result.cuts.length) add('metrics.cut_count', 'differs_from_the_cut_list')

  const windows = metrics.pacing.windows
  const windowCuts = windows.reduce((a, w) => a + w.cut_count, 0)
  if (windowCuts !== metrics.cut_count) add('metrics.pacing.windows', 'cut_sum_differs_from_cut_count')
  if (windows.length && (windows[0].start_ms !== 0 || windows[windows.length - 1].end_ms !== duration)) add('metrics.pacing.windows', 'do_not_cover_the_duration')
  windows.forEach((w, i) => {
    if (i > 0 && w.start_ms !== windows[i - 1].end_ms) add(`metrics.pacing.windows[${i}]`, 'not_contiguous')
  })
  return issues
}
