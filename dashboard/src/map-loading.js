const dialog = document.querySelector('#map-loading');
const label = document.querySelector('#map-loading-label');
const progress = document.querySelector('#map-loading-progress');
const percent = document.querySelector('#map-loading-percent');
export function setMapProgress(geography, value) {
  label.textContent = `Loading ${geography}…`;
  if (value == null) { progress.removeAttribute('value'); percent.textContent = ''; }
  else { progress.value = value; percent.textContent = `${value}%`; }
}
const app = document.querySelector('#app');
let activeController;
let busy = false, wait = async () => {}, report = console.error, stop = () => {}, start = () => {};
export const failMapUpdate = error => activeController?.abort(error);
export const isMapBusy = () => busy;
export function configureMapLoading(callbacks) { ({ wait, report, stop, start } = callbacks); }
dialog.addEventListener('cancel', event => event.preventDefault());

// A modal makes the app and map inert, including keyboard, touch and open menus.
export async function runMapUpdate(text, action) {
  if (busy) return false;
  busy = true;
  label.textContent = text;
  progress.removeAttribute('value');
  percent.textContent = '';
  start();
  app.setAttribute('aria-busy', 'true');
  document.querySelectorAll('[popover]').forEach(menu => { if (menu.matches(':popover-open')) menu.hidePopover(); });
  dialog.showModal();
  const controller = new AbortController();
  activeController = controller;
  const timer = setTimeout(() => controller.abort(new Error('The map took too long to load. Please retry.')), 45000);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once:true });
  });
  try {
    await Promise.race([(async () => {
      await action(controller.signal);
      controller.signal.throwIfAborted();
      await wait(controller.signal);
    })(), aborted]);
    return true;
  } catch (error) {
    // Signal checks in async setters prevent late responses painting over a later request.
    controller.abort(error);
    stop();
    report(error);
    return false;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    dialog.close();
    app.removeAttribute('aria-busy');
    activeController = undefined;
    busy = false;
  }
}
