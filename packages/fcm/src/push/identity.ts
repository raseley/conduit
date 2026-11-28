/**
 * What the push client tells Google it is, at check-in and at the MCS login.
 *
 * Portions derived from @liamcottle/push-receiver (MIT License, Copyright (c)
 * 2017 Matthieu Lemoine; https://github.com/liamcottle/push-receiver), whose
 * values these are, and from Chromium's GCM client and protocol definitions
 * (BSD 3-Clause License, Copyright 2013 The Chromium Authors;
 * https://chromium.googlesource.com/chromium/src/+/main/LICENSE).
 *
 * Every identity value sent to Google lives here, so changing who Conduit
 * claims to be is a change to one file. The encoders in `messages.ts` take a
 * {@link PushIdentity} as a parameter rather than reading this module, so the
 * byte-for-byte fixture tests pin their own copy of the legacy values and stay
 * valid whichever profile ships.
 *
 * Known fragility, kept on purpose: at check-in and login Conduit presents as
 * **Chrome 63 on a Mac**, while device registration (Firebase installation and
 * `register3`) presents as the **Rust+ Android app on an Android phone**. That
 * is exactly what push-receiver has always sent, so existing installs keep
 * working with the credentials minted under it. It works today, but Google
 * could start rejecting the mismatch or the old version at any time.
 */

/** The identity values the check-in and login encoders write. */
export interface PushIdentity {
  /** Profile name, for logs. */
  readonly name: string;
  /** `AndroidCheckinRequest.checkin` (`AndroidCheckinProto`). */
  readonly checkin: {
    /** `AndroidCheckinProto.type`, a `DeviceType`. */
    readonly deviceType: number;
    /** `ChromeBuildProto.platform`. */
    readonly chromePlatform: number;
    /** `ChromeBuildProto.chrome_version`. */
    readonly chromeVersion: string;
    /** `ChromeBuildProto.channel`. */
    readonly chromeChannel: number;
  };
  /** `LoginRequest` values that describe the client. */
  readonly login: {
    /** `LoginRequest.id`: Chrome sends "chrome-" and its version. */
    readonly id: string;
    /** `LoginRequest.network_type`, a Chromium `ConnectionType`. */
    readonly networkType: number;
  };
}

/**
 * The `legacy` profile: byte for byte what push-receiver sends.
 */
export const LEGACY_IDENTITY: PushIdentity = Object.freeze({
  name: "legacy",
  checkin: Object.freeze({
    // DEVICE_CHROME_BROWSER (android_checkin.proto): a desktop Chrome browser,
    // not Chrome OS and not an Android device.
    deviceType: 3,
    // PLATFORM_MAC (ChromeBuildProto.Platform). push-receiver has always said
    // Mac, whatever the real host is.
    chromePlatform: 2,
    // Chrome 63, a 2017 build: push-receiver's value, never updated since. A
    // current Chrome version is the candidate for a `modern` profile.
    chromeVersion: "63.0.3234.0",
    // CHANNEL_STABLE (ChromeBuildProto.Channel).
    chromeChannel: 1,
  }),
  login: Object.freeze({
    // Chrome's GCM client sends "chrome-" followed by its version, so this must
    // move with `checkin.chromeVersion`.
    id: "chrome-63.0.3234.0",
    // CONNECTION_ETHERNET in Chromium's net::NetworkChangeNotifier::ConnectionType,
    // as push-receiver sends regardless of the real link.
    networkType: 1,
  }),
});

/**
 * The profile the push client uses. Only `legacy` exists until the identity
 * experiment decides whether a current Chrome version can replace it.
 */
export const DEFAULT_IDENTITY: PushIdentity = LEGACY_IDENTITY;
