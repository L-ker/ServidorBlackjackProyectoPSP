# Certificado TLS autofirmado

El servidor requiere estos archivos en esta carpeta:

- `server.key`
- `server.crt`

## Generacion rapida con OpenSSL (Windows/Linux/macOS)

Ejecuta desde `blackjack-server/`:

```bash
openssl req -x509 -newkey rsa:2048 -sha256 -nodes ^
  -keyout certs/server.key ^
  -out certs/server.crt ^
  -days 365 ^
  -subj "/CN=localhost" ^
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

Si vas a conectarte desde otra maquina de la red local, cambia o anade la IP real del servidor en `subjectAltName`.

Ejemplo:

`-addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:192.168.1.35"`

## Nota para el navegador

Al ser autofirmado, el navegador marcara el certificado como no confiable hasta que lo aceptes o importes.
