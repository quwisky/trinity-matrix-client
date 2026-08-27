const query = new URLSearchParams(location.search);
const screen = query.get('screen') === 'settings' ? 'settings' : 'workspace';
const requestedScene = query.get('scene');
const scene = ['busy', 'empty', 'error'].includes(requestedScene)
  ? requestedScene
  : 'busy';
const theme = query.get('theme') ?? 'dark';

document.body.dataset.screen = screen;
document.body.dataset.scene = scene;

for (const prototype of document.querySelectorAll('[data-prototype]')) {
  prototype.hidden = prototype.getAttribute('data-prototype') !== screen;
}

const root = document.documentElement;
root.classList.toggle('dark', theme !== 'light');
if (theme === 'onyx') {
  root.dataset.theme = 'onyx';
} else {
  root.removeAttribute('data-theme');
}
