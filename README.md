# DERYI EMPRESARIAL - Inventario multiempresa

Aplicativo PWA para inventarios por empresa usando Firebase Authentication, Firestore y GitHub Pages.

## Qué incluye

- Crear empresa desde la pantalla inicial.
- Administrador principal automático para cada empresa.
- Usuarios separados por empresa.
- Inventario, conteos, laboratorios y bloqueos separados por empresa.
- Carga de Excel/ODS/CSV por empresa.
- Conteo físico por enteros y unidades.
- Bloqueo temporal de laboratorio.
- Historial básico de conteos por usuario.
- Restablecimiento de contraseña con correo de Firebase.
- Soporte oculto para el creador de la app.

## Orden de instalación

1. Crear proyecto Firebase nuevo.
2. Activar Authentication > Email/Password.
3. Crear Firestore Database en modo producción.
4. Subir estos archivos a un repositorio nuevo de GitHub.
5. Copiar el contenido de `firestore.rules` en Firebase > Firestore Database > Rules y publicar.
6. Activar GitHub Pages: Settings > Pages > Deploy from a branch > main > /root.
7. Abrir la URL de GitHub Pages.
8. Crear la primera empresa desde la pantalla inicial.

## Datos importantes

El código de empresa se genera automáticamente cuando se crea una empresa. El administrador debe compartir ese código con los usuarios que autorice.

Los datos se guardan en Firestore con esta estructura:

```text
companies/{companyId}/users
companies/{companyId}/inventory
companies/{companyId}/counts
companies/{companyId}/labLocks
companies/{companyId}/labCompletions
companies/{companyId}/appMeta
```

Cada usuario también tiene un índice en:

```text
userCompanyIndex/{uid}
```

Ese índice permite que la app sepa a qué empresa pertenece el usuario después de iniciar sesión.
