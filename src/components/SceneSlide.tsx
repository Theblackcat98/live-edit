export function SceneSlide() {
  return (
    <div className="scene-paper" data-scene-region="full">
      <div className="scene-sheen" aria-hidden="true" />
      <header className="scene-head" data-scene-region="header">
        <div className="scene-kicker">
          <span className="scene-kicker-bar" />
          <span>Q3 operating review</span>
          <span className="scene-confidential">Confidential</span>
        </div>
        <h3 className="scene-title">Revenue &amp; operating efficiency</h3>
        <div className="scene-subtitle">Operating review · 14 November · Finance</div>
      </header>

      <div className="scene-body">
        <div className="scene-left">
          <div className="scene-label">Revenue by quarter</div>
          <div className="scene-table-wrap" data-scene-region="table">
            <table className="scene-table">
              <thead>
                <tr>
                  <th>Qtr</th>
                  <th>Revenue</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Q1</td>
                  <td>$0.92M</td>
                  <td>
                    <span className="scene-status status-closed">Closed</span>
                  </td>
                </tr>
                <tr>
                  <td>Q2</td>
                  <td>$1.08M</td>
                  <td>
                    <span className="scene-status status-closed">Closed</span>
                  </td>
                </tr>
                <tr className="scene-row-q3" data-scene-region="q3-row">
                  <td>Q3</td>
                  <td>$1.20M</td>
                  <td>
                    <span className="scene-status status-pending">Pending</span>
                  </td>
                </tr>
                <tr>
                  <td>Q4</td>
                  <td>$1.35M</td>
                  <td>
                    <span className="scene-status status-forecast">Forecast</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="scene-sticky" data-scene-region="sticky">
            <span className="scene-sticky-tape" aria-hidden="true" />
            <span className="scene-sticky-label">Finance note</span>
            <span className="scene-sticky-text">Final invoice recon still pending.</span>
          </div>
        </div>

        <div className="scene-right">
          <div className="scene-formula-card" data-scene-region="formula">
            <div className="scene-label">North star</div>
            <div className="scene-formula">
              <span className="scene-frac">
                <span>LTV</span>
                <span className="scene-frac-line" />
                <span>CAC</span>
              </span>
              <span className="scene-equals">= 3.4×</span>
            </div>
            <div className="scene-formula-target">target ≥ 3.0×</div>
          </div>

          <div className="scene-chart-card" data-scene-region="chart">
            <div className="scene-label">Trajectory</div>
            <div className="scene-bars">
              <span className="scene-bar" style={{ height: '38%' }}>
                <i>0.92</i>
              </span>
              <span className="scene-bar" style={{ height: '53%' }}>
                <i>1.08</i>
              </span>
              <span className="scene-bar scene-bar-active" style={{ height: '67%' }}>
                <i>1.20</i>
              </span>
              <span className="scene-bar" style={{ height: '82%' }}>
                <i>1.35</i>
              </span>
            </div>
          </div>
        </div>
      </div>

      <footer className="scene-footer">
        <span>LFM · operating review</span>
        <span>Q3 · 2026</span>
      </footer>
    </div>
  )
}
