#include <string>

namespace ui {
class Widget {
public:
  Widget();
  ~Widget();
  int size() const;
};

class Gadget {
public:
  int size() const;
};

static std::string label() {
  return std::string("widget");
}

Widget::Widget() {}
Widget::~Widget() {}
int Widget::size() const { return static_cast<int>(label().size()); }
int Gadget::size() const { return 7; }

int measure_widget(Widget &widget) {
  return widget.size();
}

int measure_pointer(Widget *widget) {
  return widget->size();
}

int operation(int value) {
  return value - 1;
}

int increment(int value) {
  return value + 1;
}

int apply_transform(int (*operation)(int), int value) {
  return operation(value);
}

int apply_local_transform(int value) {
  int (*callback)(int) = operation;
  return callback(value);
}

int apply_shadowed_transform(int value) {
  int (*callback)(int) = operation;
  int result = callback(value);
  {
    int (*callback)(int) = increment;
    result = callback(result);
  }
  return callback(result);
}

int apply_for_shadowed_transform(int value) {
  int (*callback)(int) = operation;
  for (int (*callback)(int) = increment; value < 1; value++) {
    value = callback(value);
  }
  return callback(value);
}

int measure_qualified() {
  return ui::label().size();
}

template <typename T>
int measure_generic(T &value) {
  return value.size();
}
}
