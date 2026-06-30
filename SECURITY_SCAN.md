# Escaneo estático de seguridad - DERYI Empresarial

Versión revisada: Multiempresa v1.8 Instalación segura - 2026-06-30
Fecha: 2026-06-30

## Alcance
Revisión estática local de `index.html`, `app.js`, `firebase-config.js`, `firestore.rules`, `manifest.json` y `sw.js`. No es una auditoría profesional ni prueba de penetración real contra Firebase.

## Resultado rápido
- No se encontró uso de `eval()`, `new Function()` ni `document.write()`.
- No se encontraron enlaces `http://`; la app usa HTTPS.
- La clave `firebaseConfig.apiKey` está visible; esto es normal en apps Firebase web, pero la seguridad depende de Firestore Rules.
- Se usan librerías CDN externas: `xlsx`, `jspdf`, `jspdf-autotable` y Firebase desde `gstatic`.
- Se usa `innerHTML` para renderizado dinámico. La mayoría de valores variables pasan por `escapeHtml`, pero debe mantenerse esa regla en futuras modificaciones.
- Firestore Rules separan datos por empresa y rol, pero hay puntos a vigilar: `loginIndex` es consultable por usuario/nickname y `companies/{companyId}` permite `get` a usuarios autenticados.

## Riesgos detectados
1. Dependencias CDN sin Subresource Integrity (SRI). Riesgo medio.
2. Falta de Content-Security-Policy estricta. En GitHub Pages no es fácil configurar encabezados, pero se puede agregar CSP por meta tag con pruebas.
3. `innerHTML` debe mantenerse siempre con `escapeHtml` para evitar XSS.
4. Si el correo de soporte se compromete, tiene acceso amplio por reglas.
5. Login por nickname requiere que `loginIndex` tenga solo datos mínimos.

## Recomendaciones
- No guardar contraseñas en Firestore ni localStorage.
- Mantener reglas de Firestore publicadas desde este paquete.
- Usar Chrome para instalar la PWA en Android.
- En una etapa posterior, mover librerías CDN a archivos locales `vendor/` o agregar SRI.
- En una etapa posterior, agregar CSP y revisar que no rompa Firebase/CDN.
