/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
Cu.import('resource://gre/modules/Services.jsm');

const PAGE_WIDTH=72;
const PAGE_HEIGHT=136;
const DRIVER_PREF="sanity-test.driver-version";
const DEVICE_PREF="sanity-test.device-id";
const VERSION_PREF="sanity-test.version";
const DISABLE_VIDEO_PREF="media.hardware-video-decoding.failed";

// GRAPHICS_SANITY_TEST histogram enumeration values
const TEST_PASSED=0;
const TEST_FAILED_RENDER=1;
const TEST_FAILED_VIDEO=2;

function install() {
  var prefs = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
  prefs.setCharPref(DRIVER_PREF, "");
  prefs.setCharPref(DEVICE_PREF, "");
  prefs.setCharPref(VERSION_PREF, "");
}
function uninstall() {}

function testPixel(ctx, x, y, r, g, b, a, fuzz) {
  var data = ctx.getImageData(x, y, 1, 1);

  if (Math.abs(data.data[0] - r) <= fuzz &&
      Math.abs(data.data[1] - g) <= fuzz &&
      Math.abs(data.data[2] - b) <= fuzz &&
      Math.abs(data.data[3] - a) <= fuzz) {
    return true;
  }

  return false;
}

// Verify that the margin area is white, and that the
// <div> is red.
function testBrowserRendering(ctx) {
  return testPixel(ctx, 0, 0, 255, 255, 255, 255, 0) &&
         testPixel(ctx, 8, 8, 255, 0, 0, 255, 0);
}

// Verify that all the 4 coloured squares of the video
// render as expected (with a tolerance of 5 to allow for
// yuv->rgb differences between platforms).
//
// The video is 64x64, and is split into quadrants of
// different colours. The top left of the video is 8,72
// and we test a pixel 10,10 into each quadrant to avoid
// blending differences at the edges.
//
// We allow massive amounts of fuzz for the colours since
// it can depend hugely on the yuv -> rgb conversion, and
// we don't want to fail unnecessarily.
function testVideoRendering(ctx) {
  return testPixel(ctx, 18, 82, 255, 255, 255, 255, 64) &&
         testPixel(ctx, 50, 82, 0, 255, 0, 255, 64) &&
         testPixel(ctx, 18, 114, 0, 0, 255, 255, 64) &&
         testPixel(ctx, 50, 114, 255, 0, 0, 255, 64);
}

function hasHardwareLayers(win) {
  var winUtils = win.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindowUtils);
  if (winUtils.layerManagerType != "Basic") {
    return true;
  }
  return false;
}

function reportResult(val) {
  let histogram = Services.telemetry.getHistogramById("GRAPHICS_SANITY_TEST");
  histogram.add(val);
}

function windowLoaded(event) {
  var win = event.target;

  // Take a snapshot of the window contents, and then close the window
  var canvas = win.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.setAttribute("width", PAGE_WIDTH);
  canvas.setAttribute("height", PAGE_HEIGHT);

  // TODO: drawWindow reads back from the gpu's backbuffer, which won't catch issues with presenting
  // the front buffer via the window manager. Ideally we'd use an OS level API for reading back
  // from the desktop itself to get a more accurate test.
  var ctx = canvas.getContext("2d");
  var flags = ctx.DRAWWINDOW_DRAW_CARET | ctx.DRAWWINDOW_DRAW_VIEW | ctx.DRAWWINDOW_USE_WIDGET_LAYERS;
  ctx.drawWindow(win.ownerGlobal, 0, 0, PAGE_WIDTH, PAGE_HEIGHT, "rgb(255,255,255)", flags);
  
  win.ownerGlobal.close();

  // Update the prefs so that this test doesn't run again until the next update.
  var gfxinfo = Cc["@mozilla.org/gfx/info;1"].getService(Ci.nsIGfxInfo);
  prefs.setCharPref(DRIVER_PREF, gfxinfo.adapterDriver);
  prefs.setCharPref(DEVICE_PREF, gfxinfo.adapterDeviceID);
  prefs.setCharPref(VERSION_PREF, Services.appinfo.version);
 
  // Verify that the snapshot contains the expected contents. If it doesn't, then
  // try disabling gfx features and restart the browser.
  var prefs = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);

  if (!testBrowserRendering(ctx)) {
    reportResult(TEST_FAILED_RENDER);
    if (hasHardwareLayers(win)) {
      prefs.setBoolPref("layers.acceleration.disabled", true);
      Cc['@mozilla.org/toolkit/app-startup;1'].getService(Ci.nsIAppStartup)
        .quit(Ci.nsIAppStartup.eForceQuit | Ci.nsIAppStartup.eRestart);
      return;
    }
  }

  // TODO: When Bug 1151611 lands we can test hardware video decoding status
  // directly instead of checking the pref.
  if (!testVideoRendering(ctx)) {
    reportResult(TEST_FAILED_VIDEO);
    if (prefs.getBoolPref("layers.hardware-video-decoding.enabled")) {
      prefs.setBoolPref(DISABLE_VIDEO_PREF, true);
    }
    return;
  }

  reportResult(TEST_PASSED);
}

function startup(data, reason) {
  // Only test gfx features if firefox has updated, or if the user has a new
  // gpu or drivers.
  var prefs = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
  var gfxinfo = Cc["@mozilla.org/gfx/info;1"].getService(Ci.nsIGfxInfo);

  // TODO: Handle dual GPU setups
  if (prefs.getCharPref(DRIVER_PREF) == gfxinfo.adapterDriver &&
      prefs.getCharPref(DEVICE_PREF) == gfxinfo.adapterDeviceID &&
      prefs.getCharPref(VERSION_PREF) == Services.appinfo.version) {
    return;
  }

  // Remove any previously set failure data. These should be live prefs that
  // will take effect for the window we're about to open.
  prefs.setBoolPref(DISABLE_VIDEO_PREF, false);

  // Open a tiny window to render our test page, and notify us when it's loaded
  var win = Services.ww.openWindow(null,
                                   "chrome://sanity-test/content/sanitytest.html",
                                   "Test Page",
                                   "width=" + PAGE_WIDTH + ",height=" + PAGE_HEIGHT + ",chrome,titlebar=0",
                                   null);
  win.onload = windowLoaded;
}

function shutdown() {}
