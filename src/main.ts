import '@design/targets.css';
import { startApp } from './app/start';

const root = document.querySelector('#app');
const canvas = document.querySelector('#tunnel');
if (!(root instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) {
  throw new Error('The app mount and tunnel canvas are missing from index.html.');
}
startApp(root, canvas);
