package extras.lombok;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import lombok.Data;

@Entity
@Data
public class Shelf {
  @Id private Long id;

  private String label;
}
