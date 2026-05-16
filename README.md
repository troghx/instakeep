# Media Local Gallery

Webapp local para extraer una galeria de imagenes/videos desde HTML, JSON, source o URLs directas que el usuario ya puede ver en su navegador.

## Demo en GitHub Pages

GitHub Pages despliega solo `public/` como app estatica. Desde Pages puede:

1. Pegar HTML/JSON/source o URLs directas.
2. Auditar dimensiones reales cargando imagenes/videos en el navegador.
3. Probar variantes de mayor calidad que el navegador pueda cargar.
4. Descargar archivos directos si el CDN permite CORS; si no, abre el enlace directo en una pestana nueva.

Para usar captura local, proxy de descarga y ZIP masivo fiable, corre la app en tu equipo con `npm start`. GitHub Pages no puede leer cookies de otras paginas ni actuar como proxy.


## App en Netlify

La version cloud vive en:

https://instakeep-troghx.netlify.app

En Netlify la app incluye backend serverless:

1. `GET/POST/DELETE /api/capture` guarda y lee la ultima captura con Netlify Blobs.
2. `GET /api/probe` valida media desde Functions.
3. `GET /api/download` funciona como proxy seguro para URLs publicas HTTPS.
4. `POST/GET /api/download-zip` prepara batches en Blobs y genera ZIP por streaming.

La extension puede apuntar a local o Netlify desde el campo **App destino**. Para Netlify envia una captura compacta sin HTML completo para mantenerse bajo el limite de payload de Functions.

Nota: en Netlify las capturas pasan por Netlify Functions/Blobs; para maxima privacidad sigue usando `npm start` local. Los ZIP cloud estan sujetos al limite de respuesta streaming de Netlify.

## Uso

```powershell
npm start
```

Abre `http://127.0.0.1:5177`.

Flujos soportados:

1. Pegar una URL directa a imagen/video y descargarla.
2. Pegar HTML/JSON/source de una publicacion y pulsar `Mostrar galeria`.
3. Usar la extension local en `extension/`, elegir `App destino` local o Netlify, abrir cualquier post social ya visible en tu navegador, pulsar `Capturar visible` o `Captura profunda con scroll`, volver a la app y pulsar `Usar captura`.
4. Pulsar `Mejorar calidad` para que la app pruebe variantes HD conocidas (`orig`, `originals`, `s1080x1080`, parametros de ancho/alto, etc.) y use solo las URLs que realmente respondan como imagen/video.
5. Pulsar `Descargar >500 ZIP` para bajar en un solo archivo imagenes de al menos `500 x 500` y videos detectados, excluyendo cualquier media con dimension `540`.
6. Instagram conserva un helper opcional que genera la consulta GraphQL para posts/reels, pero ya no es el flujo principal.

La descarga y la prueba de calidad usan un proxy local o Netlify Function que solo acepta URLs publicas `https` de imagen/video. El backend rechaza hosts locales o privados.

## Companion opcional

Carga `extension/` como extension sin empaquetar en Chrome/Edge:

1. Abre `chrome://extensions` o `edge://extensions`.
2. Activa `Developer mode`.
3. Usa `Load unpacked` y selecciona la carpeta `extension`.
4. En la pagina social que quieras procesar, pulsa el icono de la extension y luego `Captura profunda con scroll` si hay muchas fotos/videos.

La extension captura HTML visible y URLs de recursos de la pestana solo cuando pulsas el boton. La captura profunda baja por la pagina para disparar lazy-loading antes de enviar los recursos vistos.

## Alcance

- No pide ni guarda credenciales.
- No lee cookies del navegador.
- En modo local no sube capturas a terceros; envia datos solo a `http://127.0.0.1:5177`. En modo Netlify, la captura compacta pasa por Netlify Functions/Blobs.
- No rompe DRM ni descarga streams protegidos. HLS cifrado se rechaza; YouTube y plataformas similares pueden exponer solo thumbnails/embeds, no archivos originales descargables.
