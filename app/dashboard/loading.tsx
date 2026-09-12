export default function DashboardLoading() {
  return (
    <div className="wv-loading" aria-label="Az alkotói munkatér betöltése" role="status">
      <div className="wv-loading-heading"><span /><strong /></div>
      <div className="wv-loading-stage">
        <div className="wv-loading-command"><span /><strong /><strong /><i /></div>
        <div className="wv-loading-artifact"><span /><div /><i /></div>
        <div className="wv-loading-spine"><span /><i /><i /><i /></div>
      </div>
      <div className="wv-loading-signals"><span /><span /><span /></div>
      <span className="sr-only">Betöltés folyamatban…</span>
    </div>
  )
}
