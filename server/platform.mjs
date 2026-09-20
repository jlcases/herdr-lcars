// Lo que cambia de una plataforma a otra al hablar con el sistema operativo.

/** Orden para abrir una URL en el navegador predeterminado. La URL viaja como argumento, sin shell. */
export function openCommand(url, platform = process.platform) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}
