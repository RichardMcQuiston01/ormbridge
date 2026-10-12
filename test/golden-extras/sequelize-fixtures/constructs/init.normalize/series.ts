import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';

export class Series extends Model<
  InferAttributes<Series>,
  InferCreationAttributes<Series>
> {
  declare id: CreationOptional<string>;
  declare handle: string;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare parentId: CreationOptional<string | null>;

  declare parent?: NonAttribute<Series>;
  declare children?: NonAttribute<Series[]>;

  static initModel(sequelize: Sequelize): typeof Series {
    Series.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        handle: {
          type: DataTypes.STRING(20),
          allowNull: false,
          unique: 'series_handle_uq',
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        parentId: DataTypes.UUID,
      },
      {
        sequelize,
        modelName: 'Series',
        tableName: 'series',
        timestamps: true,
        underscored: true,
      }
    );
    return Series;
  }
}
