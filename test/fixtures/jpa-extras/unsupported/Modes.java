package extras.unsupported;

import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;

public enum Modes {
  ON,
  OFF,
}

@Entity
class First {
  @Id private Long id;

  @Enumerated(EnumType.STRING)
  private Modes mode;
}

@Entity
class Second {
  @Id private Long id;

  private Modes mode;
}

// A record cannot be an entity, and JPA ignores it.
@Entity
record NotAnEntity(Long id) {}
