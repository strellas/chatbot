(WEB) https://strellas.github.io/chatbot/page/register/register.html

## 📖 Documentación creada

`Guía operativa completa con`:

| Sección | Contenido |
|---|---|
| **1. Rutas** | Tabla con todas las piezas (puertos, túnel, claves, BD, logs) |
| **2. Iniciar** | Los 2 comandos (túnel + backend) + cómo comprobar |
| **3. Apagar** | `Ctrl+C` + `pkill` por proceso |
| **4. Cambiar** | Puerto · dominio · proveedor IA (Local↔API) · modelo GGUF · **regenerar claves** · URL del backend · CORS · **cambiar contraseña** · desbloquear usuario · tiempos/límites |
| **5. Publicar** | `git push` del frontend |
| **6. FAQ** | Tabla de problemas → solución (incluye el "Failed to fetch") |
| **7. Reinstalar** | venv + llama-cpp con CUDA |
| **8. Seguridad** | Qué es y qué no es la clave pública |
| **9. Chuleta** | Comandos de arrancar/apagar/estado |

Ejemplos destacados que incluye:
- **Cambiar contraseña** (script con `bcrypt` + SQLite)
- **Desbloquear** usuario bloqueado
- **Rotar claves** (`generar_claves.py`) y dónde va cada valor
- **Añadir orígenes CORS** (admite lista por comas)
