package extras.unsupported;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;

@Entity
public class Broken {
  @Id private Long id;
  private String name
}
