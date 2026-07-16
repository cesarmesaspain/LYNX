#include <string>

namespace ui {
class Widget {
public:
  Widget();
  ~Widget();
  int size() const;
};

static std::string label() {
  return std::string("widget");
}

Widget::Widget() {}
Widget::~Widget() {}
int Widget::size() const { return static_cast<int>(label().size()); }
}
