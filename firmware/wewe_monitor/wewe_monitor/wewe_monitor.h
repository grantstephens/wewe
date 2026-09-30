#pragma once

#include "esphome/core/component.h"

#include <string>

namespace esphome {
namespace wewe_monitor {

class WeweMonitor : public Component {
 public:
  void setup() override;
  void loop() override;
  void dump_config() override;

  void set_signal_url(const std::string &url) { signal_url_ = url; }

  // Bridges for the touchscreen UI (display: lambda / a touch binary_sensor's
  // on_press:) — see rearm_invite()/RuntimeState in the .cpp for the actual
  // state these read/drive.
  void on_pair_tapped();
  std::string current_code() const;
  int seconds_remaining() const;
  int connected_listener_count() const;

  // Screen-off/wake — a whole-screen touch sensor calls on_screen_touched()
  // on every tap; the display: lambda calls is_screen_on() each refresh to
  // decide whether to render anything at all.
  void on_screen_touched();
  bool is_screen_on() const;

  // -1 means "no sound detected since boot"; otherwise seconds elapsed
  // since the noise gate last opened (audio_send_task in the .cpp).
  int seconds_since_last_sound() const;

 protected:
  void start_signaling_();

  std::string signal_url_;
  bool started_ = false;
};

}  // namespace wewe_monitor
}  // namespace esphome
