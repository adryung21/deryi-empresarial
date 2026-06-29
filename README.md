# DERYI Empresarial Multiempresa

Versión: Multiempresa v1.4 Usuario - 2026-06-29

## Cambios principales

- Inicio de sesión con Código de empresa + Usuario/Nickname + Contraseña.
- El correo queda como correo de contacto e invitación, no como identificador único de acceso.
- Un mismo correo de contacto puede usarse en diferentes empresas sin causar `auth/email-already-in-use`.
- Los administradores crean usuarios con nombre, nickname, correo de contacto, rol y color.
- La invitación incluye código de empresa, usuario/nickname y enlace directo a Crear acceso.
- Recuperación simple: el administrador reenvía la invitación o crea un nuevo usuario/nickname si el usuario olvidó la contraseña.

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
3. Abrir la app con `?v=14` para evitar caché anterior.
