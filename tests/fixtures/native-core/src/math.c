#include "../include/math.h"

int running_total = 0;

int add_numbers(int left, int right) {
  return left + right;
}

int hidden_helper(int value) {
  return value * 2;
}

int main(void) {
  running_total = add_numbers(2, 3);
  return running_total;
}
