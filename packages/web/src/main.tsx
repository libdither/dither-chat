import { render } from 'preact';
import { App } from './ui/App.tsx';
import { connect } from './state.ts';
import './styles.css';

connect();
render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
