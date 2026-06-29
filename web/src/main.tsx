import React from 'react'
import ReactDOM from 'react-dom/client'
import './i18n'
import './index.css'
import ZtpkiPage from './ZtpkiPage'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <main id="main">
      <ZtpkiPage />
    </main>
  </React.StrictMode>,
)
