import { render } from 'solid-js/web'
import App from './App'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

// 把 render 前后夹住：若 App.tsx 渲染阶段抛错，心跳会停在 module-evaluated，
// 直接定位断点在哪一段。M0 收尾时随其余脚手架一起删。
window.__velaBoot?.('module-evaluated', { t0Ms: window.__VELA_T0 ?? null })
render(() => <App />, root)
window.__velaBoot?.('render-returned')
