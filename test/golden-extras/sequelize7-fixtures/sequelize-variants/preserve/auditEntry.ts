import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from '@sequelize/core';
import {
  Attribute,
  AutoIncrement,
  Default,
  NotNull,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'AuditEntry', timestamps: false })
export class AuditEntry extends Model<
  InferAttributes<AuditEntry>,
  InferCreationAttributes<AuditEntry>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(255))
  @NotNull
  declare action: string;

  @Attribute(DataTypes.ENUM('info', 'warn'))
  @Default('info')
  declare level: CreationOptional<'info' | 'warn' | null>;

  @Attribute(DataTypes.DATE)
  @NotNull
  declare logged_at: Date;
}
