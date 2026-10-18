package extras.m2m;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;

@Entity
public class StoredFile {
  @Id private Long id;

  private String name;
}
