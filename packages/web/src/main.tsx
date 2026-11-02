import { render } from 'preact';
import { App } from './ui/App.tsx';
import { trackViewport } from './phone.ts';
import { registerServiceWorker } from './pwa.ts';
import { connect } from './state.ts';
import './styles.css';

connect();
trackViewport();
render(<App />, document.getElementById('app')!);

registerServiceWorker();
