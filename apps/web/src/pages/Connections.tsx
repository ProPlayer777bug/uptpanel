import { Connections } from '../components/Connections'
import { Shell } from '../components/Shell'

export function ConnectionsPage() {
  return (
    <Shell>
      <div className="page" style={{ maxWidth: 900 }}>
        <div className="page-h"><h1>Connections</h1><span className="sub">Discord, YouTube, GitHub, Reddit, Xbox &amp; Steam links shown in the ticker at the top of the panel</span></div>
        <Connections />
      </div>
    </Shell>
  )
}