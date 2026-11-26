// Installed as /opt/jitsi/.jitsi-meet-cfg/web/custom-config.js (appended to
// config.js when the web container starts). Streams each participant's
// WebRTC stats to the Speexify collector. No SDP and no console logs are sent.
config.analytics = config.analytics || {};
config.analytics.rtcstatsEnabled = true;
config.analytics.rtcstatsEndpoint = 'wss://meet.speexify.com/rtcstats';
config.analytics.rtcstatsPollInterval = 10000;
config.analytics.rtcstatsSendSdp = false;
config.analytics.rtcstatsStoreLogs = false;
