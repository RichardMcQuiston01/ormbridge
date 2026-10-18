package extras.m2m;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;

@Entity
public class Player {
  @Id private Long id;

  private String name;
}
