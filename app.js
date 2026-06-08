/**
 * SPC Canal 15 - Live Streaming Application Logic
 * Implements HLS playback with robust auto-reconnection and custom media controls.
 */

document.addEventListener('DOMContentLoaded', () => {
    // Stream Configuration
    const STREAM_URL = 'https://live20.bozztv.com/giatv/giatv-1762252013SPC/1762252013SPC/chunks.m3u8';
    
    // DOM Elements
    const video = document.getElementById('live-video');
    const playerContainer = document.getElementById('video-player-container');
    const playerOverlay = document.getElementById('player-overlay');
    const overlaySpinner = document.getElementById('overlay-spinner');
    const overlayMessage = document.getElementById('overlay-message');
    const overlayRetryBtn = document.getElementById('overlay-retry-btn');
    
    const playPauseBtn = document.getElementById('play-pause-btn');
    const iconPlay = playPauseBtn.querySelector('.icon-play');
    const iconPause = playPauseBtn.querySelector('.icon-pause');
    
    const muteBtn = document.getElementById('mute-btn');
    const iconVolumeHigh = muteBtn.querySelector('.icon-volume-high');
    const iconVolumeMuted = muteBtn.querySelector('.icon-volume-muted');
    const volumeSlider = document.getElementById('volume-slider');
    
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    const iconFullscreen = fullscreenBtn.querySelector('.icon-fullscreen');
    const iconExitFullscreen = fullscreenBtn.querySelector('.icon-exit-fullscreen');
    
    const connectionStatusText = document.getElementById('connection-status');
    const customControls = document.getElementById('custom-controls');

    // Quality Selector Elements
    const qualityContainer = document.getElementById('quality-container');
    const qualityBtn = document.getElementById('quality-btn');
    const qualityDropdown = document.getElementById('quality-dropdown');

    // State Variables
    let hls = null;
    let isReconnecting = false;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 10;
    let reconnectTimer = null;
    let watchdogTimer = null;
    let lastPlaybackTime = -1;
    let isControlsTimeoutActive = false;
    let controlsTimer = null;

    // ==========================================================================
    // Player Initialization & HLS Binding
    // ==========================================================================
    
    function initPlayer() {
        showOverlay(true, "Conectando con la señal en vivo...", true);
        connectionStatusText.textContent = "Conectando...";
        connectionStatusText.style.color = "rgba(255, 255, 255, 0.5)";

        // Reset Hls instance if exists
        if (hls) {
            hls.destroy();
            hls = null;
        }

        // Connection Speed Checking & ABR Parameters
        let isConnectionSlow = false;
        if (navigator.connection) {
            const conn = navigator.connection;
            const type = conn.effectiveType;
            const downlink = conn.downlink;
            
            if (type === '2g' || type === 'slow-2g' || type === '3g' || (downlink && downlink < 2.5)) {
                isConnectionSlow = true;
                console.log("Slow connection detected. Adjusting Hls.js parameters for maximum stability.");
            }
            
            // Listen for changes
            conn.removeEventListener('change', updateNetworkStatusUI);
            conn.addEventListener('change', updateNetworkStatusUI);
        }

        // Configure HLS.js with resilient recovery configurations optimized for fast start
        const hlsConfig = {
            enableWorker: true,
            lowLatencyMode: !isConnectionSlow,
            backBufferLength: 10,
            maxBufferLength: isConnectionSlow ? 20 : 10, // Buffer less content initially for instant start
            maxMaxBufferLength: isConnectionSlow ? 40 : 20,
            manifestLoadingMaxRetry: 6,
            manifestLoadingRetryDelay: 1000,
            levelLoadingMaxRetry: 6,
            levelLoadingRetryDelay: 1000,
            fragLoadingMaxRetry: 6,
            fragLoadingRetryDelay: 1000,
            liveSyncDurationCount: 2, // Starts playing 2 segments back instead of 3, reducing initial data needed
            maxBufferHole: 0.5,
            nudgeMaxRetries: 10,
            nudgeDelay: 100,
            maxFragLookUpTolerance: 0.25
        };

        if (Hls.isSupported()) {
            console.log("Hls.js is supported. Initializing Hls instance...");
            hls = new Hls(hlsConfig);
            hls.loadSource(STREAM_URL);
            hls.attachMedia(video);
            
            // Hls.js Events
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                console.log("HLS Manifest parsed. Ready to play.");
                setupQualitySelector();
                attemptPlay();
            });

            hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
                const currentLevelIndex = data.level;
                console.log(`Hls.js switched to level index: ${currentLevelIndex}`);
                
                // Update active class in dropdown UI if in ABR mode
                if (hls.currentLevel === -1) {
                    const autoBtn = qualityDropdown.querySelector('.quality-item[data-level="-1"]');
                    if (autoBtn && hls.levels[currentLevelIndex]) {
                        const currentLevel = hls.levels[currentLevelIndex];
                        const height = currentLevel.height || (currentLevel.attrs && currentLevel.attrs.RESOLUTION ? currentLevel.attrs.RESOLUTION.split('x')[1] : null);
                        const name = height ? `${height}p` : '';
                        autoBtn.textContent = name ? `Auto (${name})` : 'Auto';
                    }
                }
            });

            hls.on(Hls.Events.ERROR, (event, data) => {
                handleHlsError(data);
            });

        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // Native fallback (Safari/iOS)
            console.log("Native HLS playback detected (Safari/iOS).");
            video.src = STREAM_URL;
            
            if (qualityContainer) {
                qualityContainer.style.display = 'none';
            }
            
            video.addEventListener('loadedmetadata', () => {
                attemptPlay();
            });

            video.addEventListener('error', (e) => {
                handleNativeVideoError(e);
            });
        } else {
            showOverlay(false, "Tu navegador no soporta transmisiones HLS.", false);
            overlaySpinner.style.display = 'none';
            if (qualityContainer) {
                qualityContainer.style.display = 'none';
            }
        }
    }

    // ==========================================================================
    // Autoplay & Stream Control Handlers
    // ==========================================================================

    function attemptPlay() {
        video.play()
            .then(() => {
                console.log("Playback started successfully.");
                hideOverlay();
                updatePlayPauseUI(true);
                reconnectAttempts = 0;
                isReconnecting = false;
                updateNetworkStatusUI();
                startWatchdog();
            })
            .catch((error) => {
                console.warn("Autoplay blocked. Requiring user interaction.", error);
                // Prompt user to start playing manually
                showOverlay(false, "Haz clic en reproducir para sintonizar en vivo.", false);
                overlaySpinner.style.display = 'none';
                overlayRetryBtn.style.display = 'inline-block';
                overlayRetryBtn.textContent = "Reproducir Señal";
                updatePlayPauseUI(false);
            });
    }

    function togglePlay() {
        if (video.paused) {
            hideOverlay();
            video.play().then(() => {
                updatePlayPauseUI(true);
                startWatchdog();
            }).catch(err => {
                console.error("Playback error:", err);
            });
        } else {
            video.pause();
            updatePlayPauseUI(false);
            stopWatchdog();
        }
    }

    function updatePlayPauseUI(isPlaying) {
        if (isPlaying) {
            iconPlay.style.display = 'none';
            iconPause.style.display = 'block';
        } else {
            iconPlay.style.display = 'block';
            iconPause.style.display = 'none';
        }
    }

    // ==========================================================================
    // Auto-Reconnection & Recovery Logic (CRITICAL FEATURE)
    // ==========================================================================

    function handleHlsError(data) {
        if (data.fatal) {
            console.error(`Fatal HLS error encountered: ${data.type} - ${data.details}`);
            
            switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                    console.warn("Fatal Network error. Attempting Hls recovery...");
                    connectionStatusText.textContent = "Error de Red";
                    connectionStatusText.style.color = "#ef4444";
                    hls.startLoad();
                    triggerReconnection("Inestabilidad de red. Reconectando...");
                    break;
                    
                case Hls.ErrorTypes.MEDIA_ERROR:
                    console.warn("Fatal Media error. Attempting Hls media recovery...");
                    connectionStatusText.textContent = "Error de Medios";
                    connectionStatusText.style.color = "#ef4444";
                    hls.recoverMediaError();
                    break;
                    
                default:
                    console.error("Unrecoverable fatal error. Re-initializing player...");
                    triggerReconnection("Pérdida de señal. Reintentando conexión...");
                    break;
            }
        } else {
            // Non-fatal errors are logged but ignored as Hls.js recovers natively from most
            console.warn(`Non-fatal HLS error: ${data.details}`);
        }
    }

    function handleNativeVideoError(e) {
        console.error("Native video element error:", e);
        triggerReconnection("Señal interrumpida. Reintentando...");
    }

    function triggerReconnection(message) {
        if (isReconnecting) return;
        isReconnecting = true;
        stopWatchdog();
        
        reconnectAttempts++;
        console.log(`Reconnection attempt ${reconnectAttempts} of ${MAX_RECONNECT_ATTEMPTS}...`);
        
        showOverlay(true, `${message} (Intento ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`, true);
        updateNetworkStatusUI();
        
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            console.error("Max reconnection attempts reached. Halting automatic retries.");
            showOverlay(false, "No se pudo conectar con la transmisión. Verifica tu conexión a internet o intenta más tarde.", false);
            overlaySpinner.style.display = 'none';
            overlayRetryBtn.style.display = 'inline-block';
            overlayRetryBtn.textContent = "Reintentar Conexión";
            isReconnecting = false;
            return;
        }

        // Calculate backoff time (minimum 2s, maximum 10s)
        const delay = Math.min(2000 * reconnectAttempts, 10000);
        
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            console.log("Executing scheduled player re-initialization...");
            initPlayer();
        }, delay);
    }

    // Watchdog check to detect if playback has silently stalled/frozen
    function startWatchdog() {
        stopWatchdog();
        lastPlaybackTime = video.currentTime;
        
        watchdogTimer = setInterval(() => {
            if (!video.paused && !isReconnecting) {
                // If video time has not advanced while playing, the stream has hung
                if (video.currentTime === lastPlaybackTime) {
                    console.warn("Watchdog: Stream playback has frozen. Initiating reload.");
                    triggerReconnection("Señal congelada. Restableciendo...");
                } else {
                    lastPlaybackTime = video.currentTime;
                }
            }
        }, 6000); // Run check every 6 seconds
    }

    function stopWatchdog() {
        if (watchdogTimer) {
            clearInterval(watchdogTimer);
            watchdogTimer = null;
        }
    }

    // ==========================================================================
    // UI Helpers (Overlays & Controls Visibility)
    // ==========================================================================

    function showOverlay(showSpinner, text, isWaitingState) {
        playerOverlay.style.opacity = '1';
        playerOverlay.style.visibility = 'visible';
        overlayMessage.textContent = text;
        
        if (showSpinner) {
            overlaySpinner.style.display = 'block';
        } else {
            overlaySpinner.style.display = 'none';
        }
        
        if (isWaitingState) {
            overlayRetryBtn.style.display = 'none';
            playerContainer.classList.add('controls-active'); // Keep custom controls visible during errors
        }
    }

    function hideOverlay() {
        playerOverlay.style.opacity = '0';
        playerOverlay.style.visibility = 'hidden';
        overlayRetryBtn.style.display = 'none';
        playerContainer.classList.remove('controls-active');
    }

    // Custom controls auto-hide timer
    function resetControlsTimer() {
        playerContainer.classList.add('controls-active');
        if (controlsTimer) clearTimeout(controlsTimer);
        
        if (!video.paused) {
            controlsTimer = setTimeout(() => {
                playerContainer.classList.remove('controls-active');
            }, 3000);
        }
    }

    // ==========================================================================
    // Volume & Fullscreen Event Listeners
    // ==========================================================================

    function toggleMute() {
        video.muted = !video.muted;
        updateVolumeUI();
    }

    function updateVolumeUI() {
        if (video.muted || video.volume === 0) {
            iconVolumeHigh.style.display = 'none';
            iconVolumeMuted.style.display = 'block';
            volumeSlider.value = 0;
        } else {
            iconVolumeHigh.style.display = 'block';
            iconVolumeMuted.style.display = 'none';
            volumeSlider.value = video.volume;
        }
    }

    function handleVolumeSliderInput(e) {
        const value = e.target.value;
        video.volume = value;
        video.muted = (value == 0);
        updateVolumeUI();
    }

    function toggleFullscreen() {
        if (!document.fullscreenElement && !document.webkitFullscreenElement) {
            const requestFS = playerContainer.requestFullscreen || 
                              playerContainer.webkitRequestFullscreen || 
                              playerContainer.mozRequestFullScreen || 
                              playerContainer.msRequestFullscreen;
                              
            if (requestFS) {
                requestFS.call(playerContainer)
                    .then(() => {
                        playerContainer.style.borderRadius = '0';
                        iconFullscreen.style.display = 'none';
                        iconExitFullscreen.style.display = 'block';
                        
                        // Lock screen orientation to landscape on mobile
                        if (screen.orientation && typeof screen.orientation.lock === 'function') {
                            screen.orientation.lock('landscape')
                                .then(() => {
                                    console.log('Screen orientation locked to landscape');
                                })
                                .catch(err => {
                                    console.warn('Could not lock screen orientation:', err);
                                });
                        }
                    })
                    .catch(err => {
                        console.error(`Error attempting fullscreen: ${err.message}`);
                    });
            } else if (video.webkitEnterFullscreen) {
                // Safari iOS iPhone fullscreen fallback
                video.webkitEnterFullscreen();
            }
        } else {
            const exitFS = document.exitFullscreen || 
                           document.webkitExitFullscreen || 
                           document.mozCancelFullScreen || 
                           document.msExitFullscreen;
            if (exitFS) {
                exitFS.call(document);
            }
        }
    }

    // Listening to native document fullscreen changes
    function handleFullscreenChange() {
        const isFS = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
        
        if (!isFS) {
            playerContainer.style.borderRadius = '16px';
            iconFullscreen.style.display = 'block';
            iconExitFullscreen.style.display = 'none';
            
            // Unlock screen orientation when exiting fullscreen
            if (screen.orientation && typeof screen.orientation.unlock === 'function') {
                try {
                    screen.orientation.unlock();
                    console.log('Screen orientation unlocked');
                } catch (err) {
                    console.warn('Could not unlock screen orientation:', err);
                }
            }
        } else {
            playerContainer.style.borderRadius = '0';
            iconFullscreen.style.display = 'none';
            iconExitFullscreen.style.display = 'block';
        }
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);

    // ==========================================================================
    // Register Element Event Listeners
    // ==========================================================================

    // Playback buttons
    playPauseBtn.addEventListener('click', togglePlay);
    video.addEventListener('click', togglePlay);
    
    // Volume controls
    muteBtn.addEventListener('click', toggleMute);
    volumeSlider.addEventListener('input', handleVolumeSliderInput);
    
    // Fullscreen controls
    fullscreenBtn.addEventListener('click', toggleFullscreen);

    // Toggle quality dropdown menu
    qualityBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        qualityDropdown.classList.toggle('show');
        qualityContainer.classList.toggle('active');
    });

    // Close quality dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!qualityContainer.contains(e.target)) {
            qualityDropdown.classList.remove('show');
            qualityContainer.classList.remove('active');
        }
    });

    // Handle quality selection click
    qualityDropdown.addEventListener('click', (e) => {
        const item = e.target.closest('.quality-item');
        if (!item) return;

        const levelIndex = parseInt(item.getAttribute('data-level'), 10);
        console.log(`User selected quality level index: ${levelIndex}`);

        if (hls) {
            hls.currentLevel = levelIndex;
        }

        // Update active class in dropdown UI
        const items = qualityDropdown.querySelectorAll('.quality-item');
        items.forEach(el => el.classList.remove('active'));
        item.classList.add('active');

        // Close dropdown
        qualityDropdown.classList.remove('show');
        qualityContainer.classList.remove('active');
    });

    // Manual Reconnection trigger
    overlayRetryBtn.addEventListener('click', () => {
        reconnectAttempts = 0;
        initPlayer();
    });

    // Controls display timing
    playerContainer.addEventListener('mousemove', resetControlsTimer);
    playerContainer.addEventListener('touchstart', resetControlsTimer);
    
    video.addEventListener('play', () => {
        updatePlayPauseUI(true);
        resetControlsTimer();
    });
    
    video.addEventListener('pause', () => {
        updatePlayPauseUI(false);
        playerContainer.classList.add('controls-active'); // Keep visible when paused
    });

    // Simple scroll navbar spy for premium feel
    const navLinks = document.querySelectorAll('.nav-link');
    window.addEventListener('scroll', () => {
        let current = '';
        const sections = document.querySelectorAll('main, section[id]');
        
        sections.forEach(section => {
            const sectionTop = section.offsetTop;
            const sectionHeight = section.clientHeight;
            if (pageYOffset >= (sectionTop - 120)) {
                current = section.getAttribute('id');
            }
        });

        navLinks.forEach(link => {
            link.classList.remove('active');
            if (link.getAttribute('href').slice(1) === current) {
                link.classList.add('active');
            }
        });
    });

    // Keyboard controls for video (Aesthetics and UX)
    document.addEventListener('keydown', (e) => {
        // Only trigger shortcut keys when focusing body/player to avoid input capture issues
        if (document.activeElement === document.body || document.activeElement === video) {
            if (e.code === 'Space') {
                e.preventDefault();
                togglePlay();
            } else if (e.code === 'KeyM') {
                toggleMute();
            } else if (e.code === 'KeyF') {
                toggleFullscreen();
            }
        }
    });

    // ==========================================================================
    // Quality Selection & Connection Status Helpers
    // ==========================================================================
    
    function setupQualitySelector() {
        if (!hls) return;

        // Clear existing dynamic items (keep first "Auto" button)
        qualityDropdown.innerHTML = '<button class="quality-item active" data-level="-1">Auto</button>';

        const levels = hls.levels;
        console.log("HLS Quality levels found:", levels);

        if (levels && levels.length > 1) {
            levels.forEach((level, index) => {
                const height = level.height || (level.attrs && level.attrs.RESOLUTION ? level.attrs.RESOLUTION.split('x')[1] : null);
                const name = height ? `${height}p` : `Calidad ${index + 1}`;
                const btn = document.createElement('button');
                btn.className = 'quality-item';
                btn.setAttribute('data-level', index);
                btn.textContent = name;
                qualityDropdown.appendChild(btn);
            });
            qualityContainer.style.display = 'inline-block';
        } else if (levels && levels.length === 1) {
            const level = levels[0];
            const height = level.height || 720;
            const name = `${height}p`;
            
            const btn = document.createElement('button');
            btn.className = 'quality-item';
            btn.setAttribute('data-level', '0');
            btn.textContent = name;
            qualityDropdown.appendChild(btn);
            
            qualityContainer.style.display = 'inline-block';
        } else {
            qualityContainer.style.display = 'none';
        }
    }

    function updateNetworkStatusUI() {
        if (isReconnecting) {
            connectionStatusText.textContent = "Reconectando...";
            connectionStatusText.style.color = "#ef4444";
            return;
        }
        
        if (navigator.connection) {
            const conn = navigator.connection;
            const type = conn.effectiveType;
            const downlink = conn.downlink;
            
            if (type === '2g' || type === 'slow-2g' || type === '3g' || (downlink && downlink < 2.5)) {
                connectionStatusText.textContent = "Red Lenta";
                connectionStatusText.style.color = "#eab308";
                return;
            }
        }
        
        connectionStatusText.textContent = "Estable";
        connectionStatusText.style.color = "#25d366";
    }

    // ==========================================================================
    // Application Boot
    // ==========================================================================
    initPlayer();
});
