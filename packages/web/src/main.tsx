import { render } from 'preact';
import { App } from './ui/App.tsx';
import { registerServiceWorker } from './pwa.ts';
import { connect } from './state.ts';
import './styles.css';

connect();
render(<App />, document.getElementById('app')!);

registerServiceWorker();
