import { useApp } from '../state/auth'
import { AIBro } from '../components/AIBro'
import { CustomizeBackground } from '../components/CustomizeBackground'
import { Shell } from '../components/Shell'

export function General() {
  const { canAdmin } = useApp()

  return (
    <Shell>
      <div className="page" style={{ maxWidth: 900 }}>
        <div className="page-h"><h1>General</h1><span className="sub">AIBro &amp; panel appearance</span></div>
        <div className="grid gap-3">
          <AIBro />
          {canAdmin && <CustomizeBackground />}
        </div>
      </div>
    </Shell>
  )
}