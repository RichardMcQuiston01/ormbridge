package extras.single;

import jakarta.persistence.Column;
import jakarta.persistence.DiscriminatorValue;
import jakarta.persistence.Entity;

@Entity
@DiscriminatorValue("C")
public class Car extends Vehicle {
  // NOT NULL in the subclass, but Hibernate cannot enforce that for the rows of the other classes.
  @Column(nullable = false)
  private int doors;
}
