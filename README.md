# Media Local Gallery

Webapp local para extraer una galeria de imagenes/videos desde HTML, JSON, source o URLs directas que el usuario ya puede ver en su navegador.

## Demo en GitHub Pages

GitHub Pages despliega solo `public/` como demo estatica. Sirve para revisar la interfaz, pegar HTML/URLs y abrir archivos directos, pero no ejecuta el backend Node.

Para usar captura local, proxy de descarga, mejora de calidad y ZIP masivo, corre la app en tu equipo con `npm start`.

## Uso

```powershell
npm start
```

Abre `http://127.0.0.1:5177`.

Flujos soportados:

1. Pegar una URL directa a imagen/video y descargarla.
2. Pegar HTML/JSON/source de una publicacion y pulsar `Mostrar galeria`.
3. Usar la extension local en `extension/`, abrir cualquier post social ya visible en tu navegador, pulsar `Capturar visible` o `Captura profunda con scroll`, volver a la app y pulsar `Usar captura local`.
4. Pulsar `Mejorar calidad` para que la app pruebe variantes HD conocidas (`orig`, `originals`, `s1080x1080`, parametros de ancho/alto, etc.) y use solo las URLs que realmente respondan como imagen/video.
5. Pulsar `Descargar >500 ZIP` para bajar en un solo archivo imagenes de al menos `500 x 500` y videos detectados, excluyendo cualquier media con dimension `540`.
6. Instagram conserva un helper opcional que genera la consulta GraphQL para posts/reels, pero ya no es el flujo principal.

La descarga y la prueba de calidad usan un proxy local que solo acepta URLs publicas `https` de imagen/video. El servidor rechaza hosts locales o privados.

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
- No sube capturas a terceros; envia datos solo a `http://127.0.0.1:5177`.
- No rompe DRM ni descarga streams protegidos. HLS cifrado se rechaza; YouTube y plataformas similares pueden exponer solo thumbnails/embeds, no archivos originales descargables.
