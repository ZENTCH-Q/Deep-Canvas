export function register(api) {
  api.registerWidget({
    id: 'helloPlugin',
    label: 'Hello',
    html: '👋',
    onClick: () => alert('Hello from plugin!')
  });
}
