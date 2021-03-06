/*
 * The speaker object uses native web audio, and the interface boils it down
 * to the following api:
 *
 *    speaker.initializeAudio(): many clients can only start using
 *      audio when handling an 'onClick' event. This call should be made
 *      at that time to get audio initialized while waiting for details
 *      of what to play from the server.
 *
 *    speaker.setVolume(value): set the volume from 0 (mute) - 100 (full volume)
 *
 *    var sound = speaker.create(url, optionsAndEvents): create a new sound from the
 *       given url and return a 'song' object that can be used to pause/play/
 *       destroy the song and receive trigger events as the song plays/stops.
 *
 *       The 'optionsAndEvents' is an object that lets you specify event
 *       handlers and options:
 *
 *          startPosition:  specifies the time offset (in milliseconds) that the
 *                          sound should begin playback at when we begin playback.
 *          endPosition:    specifies the time offset (in milliseconds) that the
 *                          sound should stop playback
 *          fadeInSeconds:  # of seconds to fade in audio
 *          fadeOutSeconds: # of seconds to fade out audio
 *          play:           event handler for 'play' event
 *          pause:          event handler for 'pause' event
 *          finish:         event handler for 'finish' event
 *          elapse:         event handler for 'elapse' event
 *
 *       The returned object emits the following events:
 *         play: the song has started playing or resumed playing after pause
 *         pause: the song has paused playback
 *         finish: the song has completed playback and the song object
 *           is no longer usable and should be destroyed
 *         elapse: song playback has elapsed
 *
 *       The events should be received in this order only:
 *         ( play -> ( pause | play )* -> )? finish
 *
 *       Note that I represent play failures as a 'finish' call, so if
 *       we can't load a song, it will just get a 'finish' and no 'play'.
 *       The 'finish' event will have a 'true' argument passed to it on
 *       some kind of error, so you can treat those differently.
 *
 *       The returned song object has this following api:
 *         play: start playback (at the 'startPosition', if specified)
 *         pause: pause playback
 *         resume: resume playback
 *         destroy: stop playback, prevent any future playback, and free up memory
 *
 *   The speaker assumes that you'll be playing only one sound at a time. When
 *   you kick off playback of a sound, it stops playback of any existing sound.
 *   Fade-outs are handled by reporting the audio as complete when the fade-out
 *   begins, but the sound continues playback until it has fully faded out. New
 *   audio can be started while the fadeout is happening.
 */

import { Howl } from "howler";
import log from "./log";
import Events from "./events";
import { uniqueId } from "./util";
import Sound from "./sound";

const DEFAULT_VOLUME = 1.0;

const iOSp = /(iPhone|iPad)/i.test(navigator.userAgent);
const brokenWebkit = iOSp && /OS 13_[543210]/i.test(navigator.userAgent);

const SILENCE = iOSp
  ? "https://u9e9h7z5.map2.ssl.hwcdn.net/feedfm-audio/250-milliseconds-of-silence.mp3"
  : "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

//const SILENCE = 'https://dgase5ckewowv.cloudfront.net/feedfm-audio/1573592316-88123.m4a';

function d(audio) {
  return (
    " src = " +
    audio.src +
    ", time = " +
    audio.currentTime +
    ", paused = " +
    audio.paused +
    ", duration = " +
    audio.duration +
    ", readyState = " +
    audio.readyState
  );
}

Sound.prototype = {
  play: function () {
    log("sound " + this.id + " play");
    return this.speaker._playSound(this);
  },

  // pause playback of the current sound clip
  pause: function () {
    console.log("sound " + this.id + " pause");
    return this.speaker._pauseSound(this);
  },

  // resume playback of the current sound clip
  resume: function () {
    log("sound " + this.id + " resume");
    return this.speaker._playSound(this);
  },

  // elapsed number of milliseconds played
  position: function () {
    //log(this.id + ' sound position');
    return this.speaker._position(this);
  },

  // duration in milliseconds of the song
  // (this may change until the song is full loaded)
  duration: function () {
    //log(this.id + ' sound duration');
    return this.speaker._duration(this);
  },

  // stop playing the given sound clip, unload it, and disable events
  // note that no further events will be sent from this sound
  // (so no 'finish' event, in particular)
  destroy: function () {
    log("sound " + this.id + " destroy");
    this.speaker._destroySound(this);
  },

  gainAdjustedVolume: function (volume) {
    if (!this.gain) {
      return volume / 100;
    }

    var adjusted =
      Math.max(
        Math.min((volume / 100) * (50 * Math.pow(10, this.gain / 20)), 100),
        0
      ) / 100;

    //log('gain adjustment is ' + this.gain + ', and final adjusted volume is ' + adjusted);

    return adjusted;
  },
};

let Speaker = function () {};

// exports with this version of Javacript isn't working, so...
Speaker.iOSp = iOSp;
Speaker.brokenWebkit = brokenWebkit;

function createAudioContext() {
  var AudioCtor = window.AudioContext || window.webkitAudioContext;

  let desiredSampleRate = 44100;
  var context = new AudioCtor();

  // Check if hack is necessary. Only occurs in iOS6+ devices
  // and only when you first boot the iPhone, or play a audio/video
  // with a different sample rate
  if (context.sampleRate !== desiredSampleRate) {
    var buffer = context.createBuffer(1, 1, desiredSampleRate);
    var dummy = context.createBufferSource();
    dummy.buffer = buffer;
    dummy.connect(context.destination);
    dummy.start(0);
    dummy.disconnect();

    context.close(); // dispose old context
    context = new AudioCtor();
  }

  //  despite being in the moz docs, this doesn't work:
  //  if (context.state !== 'running') {
  //    throw new Error('Initial playback was not started in response to a user interaction!', context.state);
  //  }

  return context;
}

Speaker.prototype = {
  vol: 100, // 0..100
  outstandingSounds: {}, // Sound instances that have not yet been destroyed

  audioContext: null, // for mobile safari volume adjustment

  active: null, // active audio element, sound, and gain node
  fading: null, // fading audio element, sound, and gain node
  preparing: null, // preparing audio element, sound, and gain node

  // each of the above look like:
  // {
  //   audio: an HTML Audio element (created during initializeAudio() and reused)
  //   sound: refers to Sound object whose URL has been assigned to 'audio.src' and
  //          audio.play() has successfully returned.
  //   gain: AudioGainNode for iOS
  //   volume: relative volume of this sound (0..1)
  // }
  //
  // note that when audio.src is not SILENCE, and sound is null, we're waiting for
  // a return from audio.play(). If the audio.src is changed, or audio.pause() is called
  // before audio.play() returns, chrome will throw an error!
  //
  // When a sound is started, it is thrown into preparing.audio.src, then 'preparing' and
  // 'active' are swapped, then active.audio.play() is called.
  //
  // When a sound has completed playback or been destroyed, the sound property is set
  // to null, the audio is paused, and audio.src is set to SILENCE.

  prepareWhenReady: null, // url to prepare once audio is initialized

  attachEventHandlers(audioPlayer) {
    audioPlayer.on("stop", () => {
      if (audioPlayer.src === SILENCE) {
        return;
      }

      if (audioPlayer === this.fading.audio) {
        audioPlayer.src = SILENCE;
        this.fading.sound = null;
        return;
      }

      if (audioPlayer !== this.active.audio) {
        return;
      }

      if (!this.active.sound || this.active.sound.url !== audioPlayer.src) {
        log("active audio ended, but no matching sound", audioPlayer.src);
        return;
      }

      log("active audio ended");
      var sound = this.active.sound;
      this.active.sound = null;
      sound.trigger("finish");
    });

    audioPlayer.on("pause", () => {
      console.log(audioPlayer, this.active.audio);

      if (audioPlayer.src === SILENCE) {
        return;
      }

      if (
        audioPlayer !== this.active.audio ||
        audioPlayer.currentTime === audioPlayer.duration
      ) {
        return;
      }

      if (!this.active.sound || this.active.sound.url !== audioPlayer.src) {
        log("active audio pause, but no matching sound");
        return;
      }

      this.active.sound.trigger("pause");
    });

    audioPlayer.on("end", () => {
      var sound = this.active.sound;

      this.active.sound = null;

      this.active.url = SILENCE;

      sound.trigger("finish");
    });

    audioPlayer.on(`fade`, () => {
      if (
        this.active.sound.fadeOutEnd &&
        audioPlayer.seek() >= this.active.sound.fadeOutStart
      ) {
        // song hit start of fade out
        this._setVolume(this.active);

        // active becomes fading, and fading becomes active
        var fading = this.fading;
        this.fading = this.active;
        this.active = fading;

        this.active.sound = null; // not used any more

        // pretend the song finished
        this.fading.sound.trigger("finish");
      }
    });
  },

  _createAudioPlayer: async function (url) {
    var self = this;

    let audio;

    function ontimeupdate() {
      if (!self.active.sound) {
        // got an elapse event before the play() succeeded
        return;
      }

      self.active.sound.trigger("elapse");

      if (self.prepareWhenReady) {
        // we've got something we want to load. check if we've loaded
        // enough of the current song that we can start loading next song.
        self.prepare(self.prepareWhenReady);
      }

      if (audio.playing()) {
        requestAnimationFrame(ontimeupdate.bind(self));
      }
    }

    console.log(`Setting up Howl, ${url}`);
    audio = new Howl({
      src: [url],
      loop: false,
      volume: DEFAULT_VOLUME,
      onplay: function () {
        console.log(this);
        // Start upating the progress of the track.
        requestAnimationFrame(ontimeupdate.bind(self));
      },
    });

    this.attachEventHandlers(audio, url);

    return {
      url,
      sound: null,
      volume: DEFAULT_VOLUME,
      audio,
    };
  },

  initializeAudio: function () {
    console.log("Attempting to Initialize Audio");

    // On mobile devices, we need to kick off playback of a sound in
    // response to a user event. This does that.
    if (this.active === null) {
      console.log("No active player, initializing");

      this.audioContext = createAudioContext();

      return Promise.all([
        this._createAudioPlayer(SILENCE),
        this._createAudioPlayer(SILENCE),
        this._createAudioPlayer(
          this.prepareWhenReady ? this.prepareWhenReady : SILENCE
        ),
      ]).then(([active, fading, preparing]) => {
        this.active = active;
        console.log(`active player initialized`);
        this.fading = fading;
        console.log(`fading player initialized`);
        this.preparing = preparing;
        console.log(`preparing player initialized`);
        this.prepareWhenReady = null;
      });
    }
  },

  getSupportedFormats: function () {
    if (document.createElement("audio").canPlayType("audio/aac")) {
      return "aac,mp3";
    } else {
      return "mp3";
    }
  },

  _setVolume: function (audioGroup, sound) {
    if (!sound) {
      sound = audioGroup.sound;
    }

    var currentTime = audioGroup.audio.currentTime;
    var currentVolume =
      audioGroup.audio.gain &&
      audioGroup.audio.gain.gain &&
      audioGroup.audio.gain.gain.value;

    var calculatedVolume = sound.gainAdjustedVolume(this.vol);

    if (
      sound.fadeInStart !== sound.fadeInEnd &&
      currentTime < sound.fadeInStart
    ) {
      calculatedVolume = 0;

      console.log("pre-fade-in volume is 0");
    } else if (
      sound.fadeInStart !== sound.fadeInEnd &&
      currentTime >= sound.fadeInStart &&
      currentTime <= sound.fadeInEnd
    ) {
      // ramp up from 0 - 100%
      calculatedVolume =
        ((currentTime - sound.fadeInStart) /
          (sound.fadeInEnd - sound.fadeInStart)) *
        calculatedVolume;

      console.log("ramping ▲ volume", {
        currentTime: currentTime,
        currentVolume: currentVolume,
        calculatedVolume: calculatedVolume,
        sound: sound,
      });
    } else if (
      sound.fadeOutStart !== sound.fadeOutEnd &&
      currentTime > sound.fadeOutEnd
    ) {
      calculatedVolume = 0;

      console.log("post-fade-out volume is 0");
    } else if (
      sound.fadeOutStart !== sound.fadeOutEnd &&
      currentTime >= sound.fadeOutStart &&
      currentTime <= sound.fadeOutEnd
    ) {
      // ramp down from 100% to 0
      calculatedVolume =
        (1 -
          (currentTime - sound.fadeOutStart) /
            (sound.fadeOutEnd - sound.fadeOutStart)) *
        calculatedVolume;

      console.log("ramping ▼ volume", {
        currentTime: currentTime,
        currentVolume: currentVolume,
        calculatedVolume: calculatedVolume,
        sound: sound,
      });
    }

    audioGroup.audio.volume(calculatedVolume);
  },

  _debugAudioObject: function (object) {
    var events = [
      "abort",
      "load",
      "loadend",
      "loadstart",
      "loadeddata",
      "loadedmetadata",
      "canplay",
      "canplaythrough",
      "seeked",
      "seeking",
      "stalled",
      "timeupdate",
      "volumechange",
      "waiting",
      "durationchange",
      "progress",
      "emptied",
      "ended",
      "play",
      "pause",
    ];
    var speaker = this;

    for (var i = 0; i < events.length; i++) {
      object.addEventListener(events[i], function (event) {
        var audio = event.currentTarget;
        var name =
          audio === speaker.active.audio
            ? "active"
            : audio === speaker.preparing.audio
            ? "preparing"
            : "fading";

        log(name + ": " + event.type);
        log("    active: " + d(speaker.active.audio));
        log("    preparing: " + d(speaker.preparing.audio));
        log("    fading: " + d(speaker.fading.audio));

        if (audio.src === SILENCE) {
          return;
        }
      });
    }
  },

  // Create and return new sound object. This throws the song into
  // the preparing audio instance.
  create: function (url, optionsAndCallbacks) {
    var id = uniqueId("feed-play-");
    var sound = new Sound(this, optionsAndCallbacks, id, url);

    log("created play " + id + " (" + url + ")", optionsAndCallbacks);

    this.outstandingSounds[sound.id] = sound;

    // start loading sound, if we can
    if (!this.active || !this.active.audio) {
      console.log("no audio prepared yet, so preparing when ready");
      this.prepareWhenReady = sound.url;
    } else if (this.preparing.audio.src === SILENCE) {
      console.log("preparing sound now");
      this._prepare(sound.url, sound.startPosition);
    }

    return sound;
  },

  prepare: function (url) {
    if (!this.active || !this.active.audio) {
      console.log("saving url to prepare for later", url);
      this.prepareWhenReady = url;
      return;
    }

    console.log(this.active.audio, `AUDIO`);

    console.log(this.active.audio.seek(), this.active.audio._duration, `AUDIO`);

    if (
      this.active.audio._state === `loaded` &&
      this.active.audio.seek() > 20
    ) {
      console.log("active song has loaded enough, to preparing", url);
      return this._prepare(url, 0);
    }

    if (this.active.url === SILENCE) {
      console.log("preparing over silence");
      return this._prepare(url, 0);
    }

    // still loading primary audio - so hold off for now
    console.log("nothing available to do active prepare");
    this.prepareWhenReady = url;
  },

  /* eslint-disable no-console */
  logState: function (label) {
    // local testing:
    console.group("speaker: " + (label || ""));

    if (!this.active) {
      console.group("active");
      console.log("uninitialized");
      console.groupEnd();

      console.group("preparing");
      console.log("uninitialized");
      console.groupEnd();

      console.group("fading");
      console.log("uninitialized");
      console.groupEnd();
    } else {
      console.group("active");
      console.log(`audio.src: ${this.active.url}`);
      console.log(`audio.paused: ${!this.active.audio.playing()}`);
      console.log(
        `sound: ${this.active.sound ? this.active.sound.id : "NULL"}`
      );
      console.log(`volume: ${this.active.volume}`);
      console.groupEnd();

      console.group("preparing");
      console.log(`audio.src: ${this.preparing.audio.src}`);
      console.log(`audio.paused: ${!this.preparing.audio.playing()}`);
      console.log(
        `sound: ${this.preparing.sound ? this.preparing.sound.id : "NULL"}`
      );
      console.log(`volume: ${this.preparing.volume}`);
      console.groupEnd();

      console.group("fading");
      console.log(`audio.src: ${this.fading.audio.src}`);
      console.log(`audio.paused: ${!this.fading.audio.playing()}`);
      console.log(
        `sound: ${this.fading.sound ? this.fading.sound.id : "NULL"}`
      );
      console.log(`volume: ${this.fading.volume}`);
      console.groupEnd();
    }

    console.group("outstanding sounds");
    for (let id in this.outstandingSounds) {
      let play = this.outstandingSounds[id];
      console.log(play.id + ": " + play.url);
    }
    console.groupEnd();

    console.groupEnd();
  },

  _prepare: function (url, startPosition) {
    // empty out any pending request
    this.prepareWhenReady = null;

    if (this.preparing.audio.src !== url) {
      console.log("preparing " + url);
      this.audioContext = createAudioContext();

      return this._createAudioPlayer(url).then((preparing) => {
        this.preparing = preparing;
      });
    }

    if (startPosition && this.preparing.audio.currentTime !== startPosition) {
      log("advancing preparing audio to", startPosition / 1000);
      this.preparing.audio.currentTime = startPosition / 1000;
    }
  },

  /*
   * Kick off playback of the requested sound.
   */

  _playSound: function (sound) {
    var speaker = this;

    console.log("Play sound");

    if (!this.active || !this.active.audio) {
      // eslint-disable-next-line
      console.error(
        "**** player.initializeAudio() *** not called before playback!"
      );
      return;
    }

    if (this.active.sound === sound) {
      if (!this.active.audio.playing()) {
        console.log(sound.id + " was paused, so resuming");

        // resume playback
        try {
          this.active.audio.play();

          log("resumed playback");
          sound.trigger("play");
        } catch (e) {
          log("error resuming playback", e);
          speaker.active.sound = null;
          sound.trigger("finish");
        }

        if (this.fading.sound) {
          try {
            this.fading.audio.play();
            log("resumed fading playback");
          } catch (e) {
            log("error resuming fading playback", e);
            speaker.fading.sound = null;
            speaker.fading.audio.src = SILENCE;
          }
        }
      } else {
        console.log(sound.id + " is already playing");
      }
    } else {
      const assemblePlay = () => {
        // swap prepared -> active
        var active = this.active;
        this.active = this.preparing;
        this.preparing = active;

        // don't throw sound object in active until playback starts (below)
        this.active.sound = null;
        this._setVolume(this.active, sound);

        // notify clients that whatever was previously playing has finished
        if (this.preparing.sound) {
          this.preparing.audio.src = SILENCE;

          var finishedSound = this.preparing.sound;
          this.preparing.sound = null;
          finishedSound.trigger("finish");
        }

        console.log(sound.id + " initiating play()");

        var me = this.active;

        try {
          this.active.audio.play();

          if (!speaker.outstandingSounds[sound.id]) {
            log(sound.id + " play() succeeded, but sound has been destroyed");

            // this sound was killed before playback began - make sure to stop it
            if (me.audio && me.audio.src === sound.url) {
              log(sound.id + " being paused and unloaded");
              me.audio.pause();
              me.audio.src = SILENCE;
            }

            return;
          }

          console.log(sound.id + " play() succeeded");
          me.sound = sound;

          // configure fade-out now that metadata is loaded
          if (sound.fadeOutSeconds && sound.fadeOutEnd === 0) {
            sound.fadeOutStart = me.audio.duration - sound.fadeOutSeconds;
            sound.fadeOutEnd = me.audio.duration;
          }

          if (sound.startPosition) {
            log("updating start position");
            me.audio.currentTime = sound.startPosition / 1000;
            log("updated");
          }

          var paused = !me.audio.playing();

          sound.trigger("play");

          if (me.pauseAfterPlay) {
            me.audio.pause();
          } else if (paused) {
            sound.trigger("pause");
          }
        } catch (e) {
          log("error starting playback with sound " + sound.id, e);
          sound.trigger("finish", e);
        }
      };

      if (this.preparing.audio.src !== sound.url) {
        // hopefully, by this time, any sound that was destroyed before its
        // play() call completed has actually completed its play call. Otherwise
        // this will trigger an exception in the play preparation.
        this._prepare(sound.url, sound.startPosition).then(() => {
          assemblePlay();
        });
        return;
      }

      assemblePlay();
    }
  },

  _destroySound: function (sound) {
    sound.off();

    if (this.active && this.active.sound === sound) {
      console.log("destroy triggered for current sound", sound.id);
    } else {
      console.log("destroy triggered for inactive sound", sound.id);

      // if (this.active && (this.active.audio.src === sound.url)) {
      //   We're destroying the active sound, but it hasn't completed its play()
      //   yet (indicated by this.active.sound === sound), so we can't pause it
      //   here. When the play does complete, it will notice it isn't in the
      //   outstandingSounds map and it will pause itself
      // }
    }

    if (this.active && this.active.audio) {
      this.active.audio.pause();
    }

    delete this.outstandingSounds[sound.id];
  },

  flush: function () {
    // destroy all outstanding sound objects
    for (let id in this.outstandingSounds) {
      this.outstandingSounds[id].destroy();
    }
  },

  _pauseSound: function (sound) {
    if (this.active && sound.url === this.active.url) {
      if (this.active.sound === sound) {
        this.active.audio.pause();
      } else {
        // if active.sound isn't assigned, then the song is still being loaded.
        // if we try to pause() right now, it will cause the play() to throw an
        // exception... so just throw up a flag for this
        this.active.pauseAfterPlay = true;
      }
    }

    if (this.fading && this.fading.audio) {
      this.fading.audio.pause();
    }
  },

  _position: function (sound) {
    if (this.active && sound === this.active.sound) {
      if (sound.url !== this.active.url) {
        log(
          "trying to get current song position, but it is not in the active audio player"
        );
      }

      return Math.floor(this.active.audio.currentTime * 1000);
    } else {
      return 0;
    }
  },

  _duration: function (sound) {
    if (sound === this.active.sound) {
      if (sound.url !== this.active.url) {
        log(
          "trying to get current song duration, but it is not in the active audio player"
        );
      }
      var d = this.active.audio.duration;
      return isNaN(d) ? 0 : Math.floor(d * 1000);
    } else {
      return 0;
    }
  },

  // set the volume (0-100)
  setVolume: function (value) {
    if (typeof value !== "undefined") {
      this.vol = value;

      if (this.active && this.active.sound) {
        this._setVolume(this.active);
      }

      this.trigger("volume", value);
    }

    return this.vol;
  },

  getVolume: function () {
    return this.vol;
  },
};

// add events to speaker class
Object.assign(Speaker.prototype, Events);

export default Speaker;
