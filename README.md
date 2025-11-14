# Bot de moderación para Discord

Pequeño bot en **Node.js** basado en `discord.js` que expone comandos *slash* básicos para moderar un servidor en español.

## Características

- `/ban`: banea a un miembro con un motivo opcional y responde con un embed.
- `/warn`: registra advertencias persistentes por servidor en `data/warnings.json`.
- `/warnings`: muestra en un embed el número de advertencias acumuladas de un miembro.
- `/blacklist`: comando exclusivo para la cuenta `1141085246226452643` que permite añadir o quitar usuarios/servidores de la lista negra y consultar su estado. Cada vez que un usuario vetado se una o envíe mensajes, se notifica por DM.
- `/setwallet`, `/mywallet`, `/wallet`: disponibles tanto en servidores como en MD y grupos privados para guardar tu dirección pública, consultar movimientos con la API blockchain configurada y validar keys emitidas por el administrador.
- `/daracceso`: asistente privado que solo puede ejecutar el propietario para generar keys asociadas a un ID concreto; cada key queda ligada a una wallet y únicamente puede canjearla la persona autorizada.
- Sistema de verificación vía DM: al entrar al servidor el bot envía un embed con las TOS inventadas y dos botones. Al pulsar "Aceptar" se despliega un modal donde se escribe `ACEPTO` y, si todo va bien, se asigna el rol `Verificado`. Si la persona rechaza las TOS será expulsada automáticamente pero puede volver a entrar para intentarlo de nuevo.
- Los datos sensibles (`warnings.json` y `blacklist.json`) se guardan en `data/` y permanecen fuera del control de versiones.

## Requisitos

- Node.js 18 o superior.
- Dependencias declaradas en `package.json` (`discord.js`, `dotenv` y `node-fetch`).
- Un bot de Discord registrado y el token correspondiente.

## Configuración

1. Instala las dependencias:
   ```bash
   npm install
   ```
2. Crea un archivo `.env` en la raíz con el token del bot y, si quieres usar otra API blockchain, define los endpoints:
   ```ini
   DISCORD_TOKEN=tu_token_aqui
   # Opcional: personaliza la API de blockchain a consultar
   BLOCKCHAIN_API_BASE=https://api.blockcypher.com/v1/eth/main/
   BLOCKCHAIN_API_TOKEN=opcional_si_tu_proveedor_lo_exige
   ```
3. Activa los *Privileged Gateway Intents* `SERVER MEMBERS INTENT`, `MESSAGE CONTENT INTENT` y `DIRECT MESSAGES INTENT`, ya que el bot necesita detectar uniones de miembros, leer mensajes para alertar sobre personas en lista negra y enviar DMs para la verificación.
4. Configura la visibilidad de canales en tu servidor para que la gente sin el rol `Verificado` no vea ninguna categoría/canal. El bot creará el rol automáticamente si no existe cuando alguien acepte las TOS.
5. Ejecuta el bot:
   ```bash
   node bot.js
   # o
   npm start
   ```

La primera vez que ejecutes el bot se creará el directorio `data/` junto a `warnings.json`, `blacklist.json`, `wallets.json` y `accessKeys.json`. Todos están en `.gitignore` para que los datos sensibles no se suban al repositorio.

## Sistema de wallets y keys

- `data/wallets.json` guarda la wallet que cada usuario configuró mediante `/setwallet` para poder consultar sus movimientos en cualquier servidor o MD con `/mywallet`.
- `data/accessKeys.json` almacena las keys emitidas por `/daracceso`. El asistente se ejecuta íntegramente por DM con el propietario y pregunta por la ID del usuario y la wallet a vincular antes de generar la key.
- `/wallet <key>` valida que quien invoca el comando es el mismo ID autorizado; si lo es, consulta la API blockchain y muestra un embed con el balance y los cinco últimos movimientos devueltos por la API. Cada intento queda registrado en `accessKeys.json` con la fecha y el usuario que canjeó la key.

Todos estos comandos están habilitados para servidores, MD individuales y grupos privados, así que se pueden usar aunque el bot no esté compartiendo un servidor con el usuario.

## Flujo de verificación

1. En cuanto un usuario entre al servidor, el bot intentará mandarle un DM con un embed que contiene las TOS descritas y dos botones: **Aceptar** y **Rechazar**.
2. Si pulsa **Aceptar**, se mostrará un modal pidiéndole escribir `ACEPTO`. Una vez enviado, el bot le asignará automáticamente el rol `Verificado` y podrá ver el resto del servidor.
3. Si pulsa **Rechazar** (o escribe algo incorrecto), se le notificará por privado y el bot lo expulsará del servidor. El usuario puede volver a entrar si cambia de opinión.
4. Siempre que una persona esté en lista negra y entre o hable en algún servidor donde esté el bot, la cuenta `1141085246226452643` recibirá un DM con la alerta correspondiente.
