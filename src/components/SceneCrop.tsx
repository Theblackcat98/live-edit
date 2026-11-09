import { ScanLine, Sparkles } from 'lucide-react'

export function SceneCrop({ region }: { region: string }) {
  if (region === 'formula') {
    return (
      <div className="crop-body crop-formula">
        <span className="crop-label">North star</span>
        <div className="crop-fraction">
          <span>LTV</span>
          <span className="crop-rule" />
          <span>CAC</span>
        </div>
        <span className="crop-value">3.4×</span>
      </div>
    )
  }
  if (region === 'table' || region === 'q3-row') {
    return (
      <div className="crop-body crop-table">
        <span className="crop-label">Revenue</span>
        {[
          ['Q1', '0.92'],
          ['Q2', '1.08'],
          ['Q3', '1.20'],
          ['Q4', '1.35'],
        ].map(([quarter, value]) => (
          <span key={quarter} className={`crop-row ${quarter === 'Q3' ? 'is-highlight' : ''}`}>
            <span>{quarter}</span>
            <span>${value}M</span>
          </span>
        ))}
      </div>
    )
  }
  if (region === 'chart') {
    return (
      <div className="crop-body crop-chart">
        <span className="crop-label">Trajectory</span>
        <div className="crop-bars">
          <span style={{ height: '42%' }} />
          <span style={{ height: '56%' }} />
          <span style={{ height: '70%' }} className="is-highlight" />
          <span style={{ height: '86%' }} />
        </div>
      </div>
    )
  }
  if (region === 'sticky') {
    return (
      <div className="crop-body crop-sticky">
        <span className="crop-label">Finance note</span>
        <span className="crop-sticky-text">Invoice recon pending.</span>
      </div>
    )
  }
  return (
    <div className="crop-body crop-full">
      <span className="crop-label">Operating review</span>
      <span className="crop-title">Revenue &amp; efficiency</span>
      <div className="crop-lines">
        <span />
        <span />
        <span />
      </div>
    </div>
  )
}

interface SceneCropCardProps {
  label: string
  region: string
  confidence: number
}

export function SceneCropCard({ label, region, confidence }: SceneCropCardProps) {
  return (
    <div className="roi-crop animate-pop-in">
      <div className="roi-crop-head">
        <ScanLine size={11} />
        <span>ROI crop</span>
        <span className="roi-crop-conf mono">{Math.round(confidence * 100)}%</span>
      </div>
      <div className="roi-crop-body">
        <SceneCrop region={region} />
        <div className="roi-crop-footer">
          <span className="mono">{label}</span>
          <span className="roi-crop-arrow">
            <Sparkles size={9} /> local
          </span>
        </div>
      </div>
    </div>
  )
}
