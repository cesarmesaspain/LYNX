#include "../include/math.h"

int consume_numbers(void) {
  int sum = add_numbers(4, 5);
  int macro_sum = MATH_ADD(1, 2);
  return hidden_helper(sum + macro_sum);
}
