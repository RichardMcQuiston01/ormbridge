package extras.perclass;

import jakarta.persistence.Entity;

@Entity
public class Dog extends Animal {
  private boolean trained;
}
