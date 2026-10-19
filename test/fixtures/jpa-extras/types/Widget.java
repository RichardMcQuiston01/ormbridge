package extras.types;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;

// The table is named after the entity name, not the class: @Entity(name) wins.
@Entity(name = "Gadget")
public class Widget {
  @Id private Long id;
}
