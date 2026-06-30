# DERYI Empresarial Multiempresa

Versión: Multiempresa v1.6 Documentos - 2026-06-29

## Cambios principales

- Inicio de sesión con Usuario/Nickname → Buscar empresas → Seleccionar empresa → Contraseña.

- Creación de empresa con 4 campos obligatorios para el administrador principal: primer nombre, segundo nombre, apellido paterno y apellido materno.
- Nickname del administrador generado automáticamente: inicial del primer nombre + inicial del segundo nombre + hasta 5 letras del apellido paterno + inicial del apellido materno.
- Validación de documento: cédula 10 dígitos, RUC 13 dígitos terminado en 001, pasaporte alfanumérico de 3 a 13 caracteres.
- Si el mismo nickname existe en varias empresas, el usuario elige en cuál entrar.
- El rol se carga por empresa: puede ser inventariador en una empresa y administrador en otra.
- Se mantiene una opción secundaria “Ingresar con código / soporte” para empresas creadas antes de esta versión o soporte técnico.
- El correo queda como correo de contacto e invitación, no como identificador único de acceso.
- La invitación sigue llevando enlace directo a Crear acceso.
- Se agregó índice `loginIndex` para que la app pueda encontrar empresas por nickname.

## Archivos importantes

- `index.html`
- `app.js`
- `styles.css`
- `firebase-config.js`
- `manifest.json`
- `sw.js`
- `firestore.rules`

## Después de subir a GitHub

1. Reemplazar archivos en la raíz del repositorio.
2. Copiar `firestore.rules` en Firebase → Firestore Database → Rules → Publicar.
3. Abrir la app con `?v=16` para evitar caché anterior.

## Nota de compatibilidad

Si una empresa fue creada antes de esta versión y todavía no aparece al buscar por usuario, entra una vez usando “Ingresar con código / soporte”. Al ingresar como administrador, la app sincroniza automáticamente los usuarios de esa empresa al nuevo índice de búsqueda.
