import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import 'katex/dist/katex.min.css'
import './styles/tokens.css'
import './styles/layout.css'
import './styles/visual.css'
import './styles/session.css'
import './styles/document.css'
import './styles/rail.css'
import './styles/trace.css'
import './styles/about.css'
import './styles/responsive.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
