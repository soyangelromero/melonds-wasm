# Fase 2: ciclo de vida libretro observado (melonDS DS v1.4.0)

Rutas relativas a `third_party/melonds-ds/src/libretro/`. Lo marcado «(probado)» se vio en la ejecución real
(`tests/phase2-smoke.mjs`, `tests/headless.mjs`); el resto se leyó del código.

1. `retro_set_environment` (`environment.cpp:800-921`, el anfitrión lo llama primero) lanza, sin mirar el resultado,
   `SET_CORE_OPTIONS_UPDATE_DISPLAY_CALLBACK`, `SET_NETPACKET_INTERFACE`, `SET_CONTENT_INFO_OVERRIDE`, `SET_CONTROLLER_INFO`,
   `SET_SUPPORT_ACHIEVEMENTS`, `SET_FRAME_TIME_CALLBACK`, `SET_PROC_ADDRESS_CALLBACK`, `SET_SUBSYSTEM_INFO` y `SET_SUPPORT_NO_GAME`.
2. Los `GET_*` de ese punto: `GET_LOG_INTERFACE` (sin él solo avisa), `GET_RUMBLE_INTERFACE` / `GET_SENSOR_INTERFACE` (false = sin vibración ni sensor),
   `GET_INPUT_BITMASKS` (true = modo máscara; el núcleo pide `RETRO_DEVICE_ID_JOYPAD_MASK`), `GET_DEVICE_POWER` (false = no crea la tarea de batería),
   `GET_MESSAGE_INTERFACE_VERSION` (devolvemos 1 = activa la tarea OSD de `core/tasks.cpp:385-470`, que envía un `SET_MESSAGE_EXT` tipo STATUS por fotograma).
3. `GET_SAVE_DIRECTORY` / `GET_SYSTEM_DIRECTORY` (`environment.cpp:857-905`): el núcleo crea `<dir>/melonDS DS` con `path_mkdir`;
   por eso `mds_create` hace `mkdir("/system")` y `mkdir("/save")` **antes** de `retro_set_environment`. (probado)
4. `GET_VFS_INTERFACE` (`environment.cpp:910`): devolvemos false. El núcleo solo emite `warn("Could not get VFS interface 3, falling back to libretro-common defaults")`
   y usa stdio sobre MEMFS. No es un error. (probado)
5. `retro_init` (`libretro.cpp:56`): `env::init`, `task::init(false, …)` (cola de tareas sin hilos propios) y construye `CoreState` por placement-new.
6. `retro_load_game` → `CoreState::LoadGame` (`core/core.cpp:~590-730`): `InitContent` (valida la ROM), `SET_PIXEL_FORMAT` (si no devolvemos true para XRGB8888 lanza
   `environment_exception`), `RegisterCoreOptions` (`GET_CORE_OPTIONS_VERSION` → `SET_CORE_OPTIONS_V2`; con false intenta V1 y V0, `environment.cpp:171-273`),
   `ParseConfig` (un `GET_VARIABLE` por clave).
7. `GET_VARIABLE` con clave desconocida o que devolvemos false: `retro::get_variable` (`environment.cpp:520`) devuelve cadena vacía y el parser usa el valor por defecto.
   Con `melonds_threaded_renderer` además emite un `warn` (`config/config.cpp:879-885`). El anfitrión guarda los valores por defecto de `SET_CORE_OPTIONS_V2`
   **sin pisar** lo fijado con `mds_set_option` (error corregido en esta fase: la primera versión sobrescribía). (probado)
8. `CreateConsole`: sin BIOS/firmware en `/system` registra `Failed to open firmware file "/system//notfound"` y cae a firmware integrado y FreeBIOS (arranque directo). (probado)
9. Si el modo de render no es OpenGL (`ENABLE_OPENGL=OFF`) nunca llama a `SET_HW_RENDER`; llama a `StartConsole` en el acto y registra «No need to defer initialization». (probado)
10. `SET_INPUT_DESCRIPTORS` (11) y `GET_MICROPHONE_INTERFACE` (false = «substituting silence») salen de `LoadGame` (`core.cpp:686`, `:804`). El anfitrión ya acepta el primero.
11. Errores de carga: `LoadGame` captura `content_exception`/`emulator_exception`/`std::exception` (`core.cpp:~700-725`), llama a `SET_MESSAGE_EXT` y devuelve false.
    **Requiere excepciones C++ activas**: con las de Emscripten por defecto (desactivadas) el `throw` abortaba el proceso («Aborted(undefined)»). Solución: `-fwasm-exceptions`. (probado)
12. `retro_run` → `CoreState::Run` (`core.cpp:180`): cada fotograma llama a `GET_VARIABLE_UPDATE`, `NDS::RunFrame`, `video_refresh` (siempre un buffer XRGB8888 256x384, pitch 1024)
    y `audio_sample_batch`. `SET_GEOMETRY` solo si cambia el layout. `video_refresh(NULL, …)` = repetir fotograma (manejado; no ocurrió en 300 fotogramas). (probado)
13. `SHUTDOWN` / `SET_VARIABLE` / `GET_FASTFORWARDING` / `GET_THROTTLE_STATE` / `GET_TARGET_REFRESH_RATE` / `SET_FASTFORWARDING_OVERRIDE`: devolvemos false; el núcleo lo trata como «no soportado» (`std::optional` vacío).
14. Único `RETRO_ENVIRONMENT_*` que el anfitrión no conocía: nº 11 (`SET_INPUT_DESCRIPTORS`), ahora aceptado. Ningún otro aparece en el registro `[host] unhandled`. (probado)
15. `retro_unload_game` + `retro_deinit` (`libretro.cpp:96`, `:138`) esperan a las tareas y destruyen `CoreState`; `mds_destroy` los llama. Tras un `mds_load_rom` fallido se puede destruir sin problema. (probado)
16. `retro_sleep` (`libretro-common/include/retro_timers.h`) está «definida en el frontend» en Emscripten; la usan `task_queue.c`, `config/console.cpp:942` y `platform/platform.cpp:90`. La define `core/host/host.cpp` (`usleep`). Sin ella el enlace falla.
17. Hilos: `Platform::Thread_Create` (`platform/thread.cpp:38`) usa `sthread_create` (rthreads sobre pthreads) solo con `HAVE_THREADS`. Con `melonds_threaded_renderer=enabled`
    el renderizador por software lanza un hilo (`GPU3D_Soft.cpp: SetupRenderThread`). (probado: 1 worker con la opción activada, 0 con ella desactivada)
